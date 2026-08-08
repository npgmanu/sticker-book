import {
  publicEmailConfig,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  type EmailEnv,
} from "./email.ts";

export type AuthEnv = EmailEnv & { DB: D1Database };
type AuthContext = { waitUntil(promise: Promise<unknown>): void };
type TokenPurpose = "verify" | "reset";

const SESSION_COOKIE = "sticker_session";
const SESSION_DAYS = 30;
const ITERATIONS = 100000;
const NEUTRAL_RESET_MESSAGE = "If an account exists for that email, we've sent a password reset link.";
const NEUTRAL_VERIFICATION_MESSAGE = "If that email can be verified, we've sent a verification link.";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  return new Uint8Array(hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function randomToken(byteLength = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function hashPassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function validEmail(email: string) {
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254;
}

function sameOrigin(request: Request, url: URL) {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? null;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function viewerFromSession(request: Request, db: D1Database) {
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const viewer = await db.prepare(
    `SELECT u.email,
            u.display_name AS displayName,
            u.is_admin AS isAdmin,
            v.verified_at AS emailVerifiedAt
     FROM sessions s
     JOIN users u ON u.email = s.user_email
     LEFT JOIN email_verification_status v ON v.user_email = u.email
     WHERE s.token_hash = ?
       AND datetime(s.expires_at) > CURRENT_TIMESTAMP
       AND u.is_disabled = 0`,
  ).bind(tokenHash).first<{ email: string; displayName: string; isAdmin: number; emailVerifiedAt: string | null }>();
  return viewer ? { email: viewer.email, displayName: viewer.displayName, isAdmin: Boolean(viewer.isAdmin), emailVerified: Boolean(viewer.emailVerifiedAt) } : null;
}

async function createSession(db: D1Database, email: string) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.prepare("INSERT INTO sessions (token_hash, user_email, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, email, expires.toISOString()).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function enforceRateLimit(db: D1Database, key: string, maximum: number, windowMinutes: number) {
  const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const result = await db.prepare(
    `INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(rate_key) DO UPDATE SET
       attempts = CASE WHEN datetime(window_started_at) < datetime(?) THEN 1 ELSE attempts + 1 END,
       window_started_at = CASE WHEN datetime(window_started_at) < datetime(?) THEN CURRENT_TIMESTAMP ELSE window_started_at END
     RETURNING attempts`,
  ).bind(key, cutoff, cutoff).first<{ attempts: number }>();
  if (Number(result?.attempts ?? 1) <= maximum) return null;
  return Response.json({ error: "Too many attempts. Please wait and try again." }, { status: 429, headers: { "Retry-After": String(windowMinutes * 60) } });
}

async function rateKey(prefix: string, request: Request, email = "") {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${prefix}:${await sha256(ip)}${email ? `:${await sha256(email)}` : ""}`;
}

async function verifyPassword(db: D1Database, email: string, password: string) {
  const user = await db.prepare(
    `SELECT u.email,
            u.display_name AS displayName,
            u.password_hash AS passwordHash,
            u.password_salt AS passwordSalt,
            u.is_disabled AS isDisabled,
            COALESCE(v.required, 0) AS verificationRequired,
            v.verified_at AS emailVerifiedAt
     FROM users u
     LEFT JOIN email_verification_status v ON v.user_email = u.email
     WHERE u.email = ?`,
  ).bind(email).first<{
    email: string;
    displayName: string;
    passwordHash: string | null;
    passwordSalt: string | null;
    isDisabled: number;
    verificationRequired: number;
    emailVerifiedAt: string | null;
  }>();
  if (!user?.passwordHash || !user.passwordSalt || user.isDisabled) return null;
  return safeEqual(await hashPassword(password, hexToBytes(user.passwordSalt)), user.passwordHash) ? user : null;
}

async function issueToken(db: D1Database, email: string, purpose: TokenPurpose, lifetimeMinutes: number) {
  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const expiresAt = new Date(Date.now() + lifetimeMinutes * 60000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM auth_tokens WHERE datetime(expires_at) <= CURRENT_TIMESTAMP"),
    db.prepare("DELETE FROM auth_tokens WHERE user_email = ? AND purpose = ?").bind(email, purpose),
    db.prepare("INSERT INTO auth_tokens (token_hash, user_email, purpose, expires_at) VALUES (?, ?, ?, ?)").bind(tokenHash, email, purpose, expiresAt),
  ]);
  return { rawToken, tokenHash, expiresAt };
}

async function sendVerificationForEmail(db: D1Database, env: AuthEnv, email: string) {
  const token = await issueToken(db, email, "verify", 24 * 60);
  try {
    await sendVerificationEmail(env, email, token.rawToken, token.tokenHash);
    return true;
  } catch {
    await db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").bind(token.tokenHash).run();
    return false;
  }
}

export async function sendPasswordResetForEmail(db: D1Database, env: AuthEnv, email: string) {
  const token = await issueToken(db, email, "reset", 60);
  try {
    await sendPasswordResetEmail(env, email, token.rawToken, token.tokenHash);
    return true;
  } catch {
    await db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").bind(token.tokenHash).run();
    return false;
  }
}

function notifyPasswordChanged(env: AuthEnv, ctx: AuthContext, email: string) {
  const eventId = randomToken(16);
  ctx.waitUntil(sendPasswordChangedEmail(env, email, eventId).catch(() => undefined));
}

async function consumeToken(db: D1Database, rawToken: string, purpose: TokenPurpose) {
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const tokenHash = await sha256(rawToken);
  return db.prepare(
    `DELETE FROM auth_tokens
     WHERE token_hash = ?
       AND purpose = ?
       AND datetime(expires_at) > CURRENT_TIMESTAMP
       AND user_email IN (SELECT email FROM users WHERE is_disabled = 0)
     RETURNING user_email AS userEmail`,
  ).bind(tokenHash, purpose).first<{ userEmail: string }>();
}

export async function handleAuthRequest(request: Request, env: AuthEnv, ctx: AuthContext) {
  const url = new URL(request.url);

  if (url.pathname === "/api/auth/public-config" && request.method === "GET") {
    return Response.json(publicEmailConfig(env), { headers: { "Cache-Control": "public, max-age=300" } });
  }

  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const viewer = await viewerFromSession(request, env.DB);
    return viewer ? Response.json({ viewer }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Signed out" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  if (request.method === "POST" && !sameOrigin(request, url)) {
    return Response.json({ error: "Request origin is not allowed" }, { status: 403 });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = sessionToken(request);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  if (url.pathname === "/api/auth/verify-email" && request.method === "POST") {
    const body = await request.json() as { token?: string };
    const rawToken = body.token?.trim().toLowerCase() ?? "";
    const limited = await enforceRateLimit(env.DB, await rateKey("verify-token", request), 20, 60);
    if (limited) return limited;
    const token = await consumeToken(env.DB, rawToken, "verify");
    if (!token) return Response.json({ error: "Verification link is invalid or expired" }, { status: 400 });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_verification_status (user_email, required, verified_at, updated_at)
         VALUES (?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(user_email) DO UPDATE SET verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
      ).bind(token.userEmail),
      env.DB.prepare("DELETE FROM auth_tokens WHERE user_email = ? AND purpose = 'verify'").bind(token.userEmail),
    ]);
    return Response.json(
      { ok: true, email: token.userEmail },
      { headers: { "Set-Cookie": await createSession(env.DB, token.userEmail), "Cache-Control": "no-store" } },
    );
  }

  if (url.pathname === "/api/auth/resend-verification" && request.method === "POST") {
    const viewer = await viewerFromSession(request, env.DB);
    const body = await request.json() as { email?: string };
    const email = (viewer?.email ?? body.email ?? "").trim().toLowerCase();
    if (!validEmail(email)) return Response.json({ ok: true, message: NEUTRAL_VERIFICATION_MESSAGE });
    const ipLimited = await enforceRateLimit(env.DB, await rateKey("verify-resend-ip", request), 10, 60);
    if (ipLimited) return ipLimited;
    const addressLimited = await enforceRateLimit(env.DB, `verify-resend-email:${await sha256(email)}`, 3, 60);
    if (addressLimited) return addressLimited;
    const target = await env.DB.prepare(
      `SELECT u.email
       FROM users u
       LEFT JOIN email_verification_status v ON v.user_email = u.email
       WHERE u.email = ? AND u.is_disabled = 0 AND v.verified_at IS NULL`,
    ).bind(email).first<{ email: string }>();
    if (target) await sendVerificationForEmail(env.DB, env, target.email);
    return Response.json({ ok: true, message: NEUTRAL_VERIFICATION_MESSAGE });
  }

  if (url.pathname === "/api/auth/change-unverified-email" && request.method === "POST") {
    const body = await request.json() as { currentEmail?: string; newEmail?: string; password?: string };
    const currentEmail = body.currentEmail?.trim().toLowerCase() ?? "";
    const newEmail = body.newEmail?.trim().toLowerCase() ?? "";
    const password = body.password ?? "";
    const limited = await enforceRateLimit(env.DB, await rateKey("change-pending-email", request, currentEmail), 5, 60);
    if (limited) return limited;
    if (!validEmail(currentEmail) || !validEmail(newEmail) || password.length < 10 || password.length > 128 || currentEmail === newEmail) {
      return Response.json({ error: "The email address could not be changed" }, { status: 400 });
    }
    const user = await verifyPassword(env.DB, currentEmail, password);
    if (!user || !user.verificationRequired || user.emailVerifiedAt) {
      return Response.json({ error: "The email address could not be changed" }, { status: 400 });
    }
    const collision = await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(newEmail).first();
    if (collision) return Response.json({ error: "The email address could not be changed" }, { status: 400 });
    const children = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM sessions WHERE user_email = ?) +
        (SELECT COUNT(*) FROM user_collections WHERE user_email = ?) +
        (SELECT COUNT(*) FROM trade_basket_items WHERE user_email = ?) +
        (SELECT COUNT(*) FROM trade_history WHERE user_email = ?) +
        (SELECT COUNT(*) FROM manual_password_resets WHERE user_email = ?) AS childCount`,
    ).bind(currentEmail, currentEmail, currentEmail, currentEmail, currentEmail).first<{ childCount: number }>();
    if (Number(children?.childCount ?? 0) > 0) return Response.json({ error: "The email address could not be changed" }, { status: 409 });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_tokens WHERE user_email = ?").bind(currentEmail),
      env.DB.prepare("DELETE FROM email_verification_status WHERE user_email = ?").bind(currentEmail),
      env.DB.prepare("UPDATE users SET email = ?, display_name = CASE WHEN display_name = ? THEN ? ELSE display_name END, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(newEmail, currentEmail, newEmail, currentEmail),
      env.DB.prepare("INSERT INTO email_verification_status (user_email, required) VALUES (?, 1)").bind(newEmail),
    ]);
    const emailSent = await sendVerificationForEmail(env.DB, env, newEmail);
    return Response.json({ ok: true, email: newEmail, emailSent });
  }

  if (url.pathname === "/api/auth/forgot-password" && request.method === "POST") {
    const body = await request.json() as { email?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    const ipLimited = await enforceRateLimit(env.DB, await rateKey("forgot-ip", request), 10, 60);
    if (ipLimited) return ipLimited;
    if (validEmail(email)) {
      const addressLimited = await enforceRateLimit(env.DB, `forgot-email:${await sha256(email)}`, 3, 60);
      if (addressLimited) return addressLimited;
      const user = await env.DB.prepare("SELECT email FROM users WHERE email = ? AND is_disabled = 0").bind(email).first<{ email: string }>();
      if (user) await sendPasswordResetForEmail(env.DB, env, user.email);
    }
    return Response.json({ ok: true, message: NEUTRAL_RESET_MESSAGE });
  }

  if (url.pathname === "/api/auth/reset-password" && request.method === "POST") {
    const body = await request.json() as { token?: string; newPassword?: string };
    const rawToken = body.token?.trim().toLowerCase() ?? "";
    const password = body.newPassword ?? "";
    const ipLimited = await enforceRateLimit(env.DB, await rateKey("reset-attempt-ip", request), 12, 30);
    if (ipLimited) return ipLimited;
    const tokenLimited = await enforceRateLimit(env.DB, `reset-attempt-token:${await sha256(rawToken)}`, 5, 30);
    if (tokenLimited) return tokenLimited;
    if (!/^[a-f0-9]{64}$/.test(rawToken) || password.length < 10 || password.length > 128) {
      return Response.json({ error: "Reset link is invalid or expired" }, { status: 400 });
    }
    const token = await consumeToken(env.DB, rawToken, "reset");
    if (!token) return Response.json({ error: "Reset link is invalid or expired" }, { status: 400 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(await hashPassword(password, salt), bytesToHex(salt), token.userEmail),
      env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(token.userEmail),
      env.DB.prepare("DELETE FROM auth_tokens WHERE user_email = ? AND purpose = 'reset'").bind(token.userEmail),
    ]);
    notifyPasswordChanged(env, ctx, token.userEmail);
    return Response.json({ ok: true, message: "Password updated" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
    const viewer = await viewerFromSession(request, env.DB);
    if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });
    const body = await request.json() as { currentPassword?: string; newPassword?: string };
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 10 || body.newPassword.length > 128) return Response.json({ error: "New password must be 10 to 128 characters" }, { status: 400 });
    const limited = await enforceRateLimit(env.DB, await rateKey("change-password", request, viewer.email), 8, 30);
    if (limited) return limited;
    if (!await verifyPassword(env.DB, viewer.email, body.currentPassword)) return Response.json({ error: "Current password is incorrect" }, { status: 401 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
      .bind(await hashPassword(body.newPassword, salt), bytesToHex(salt), viewer.email).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(viewer.email).run();
    notifyPasswordChanged(env, ctx, viewer.email);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": await createSession(env.DB, viewer.email), "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/auth/delete-account" && request.method === "POST") {
    const viewer = await viewerFromSession(request, env.DB);
    if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });
    const body = await request.json() as { password?: string; confirmation?: string };
    if (body.confirmation !== "DELETE" || !body.password || !await verifyPassword(env.DB, viewer.email, body.password)) return Response.json({ error: "Password or confirmation is incorrect" }, { status: 400 });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_tokens WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM email_verification_status WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM trade_history_items WHERE history_id IN (SELECT id FROM trade_history WHERE user_email = ?)").bind(viewer.email),
      env.DB.prepare("DELETE FROM trade_history WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM user_collections WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM manual_password_resets WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM users WHERE email = ?").bind(viewer.email),
    ]);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.json() as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!validEmail(email)) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  if (password.length < 10 || password.length > 128) return Response.json({ error: "Password must be 10 to 128 characters" }, { status: 400 });

  if (url.pathname === "/api/auth/signup") {
    const limited = await enforceRateLimit(env.DB, await rateKey("signup", request), 5, 60);
    if (limited) return limited;
    const existing = await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(email).first();
    if (existing) return Response.json({ error: "An account already exists for this email" }, { status: 409 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await hashPassword(password, salt);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)").bind(email, email, passwordHash, bytesToHex(salt)),
      env.DB.prepare("INSERT INTO email_verification_status (user_email, required) VALUES (?, 1)").bind(email),
    ]);
    const emailSent = await sendVerificationForEmail(env.DB, env, email);
    return Response.json({ ok: true, email, verificationRequired: true, emailSent }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/auth/login") {
    const limited = await enforceRateLimit(env.DB, await rateKey("login", request, email), 8, 15);
    if (limited) return limited;
    const user = await verifyPassword(env.DB, email, password);
    if (!user) return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    if (user.verificationRequired && !user.emailVerifiedAt) {
      return Response.json({ error: "Verify your email before signing in", code: "EMAIL_VERIFICATION_REQUIRED", email }, { status: 403 });
    }
    return Response.json(
      { viewer: { email: user.email, displayName: user.displayName, emailVerified: Boolean(user.emailVerifiedAt) } },
      { headers: { "Set-Cookie": await createSession(env.DB, email), "Cache-Control": "no-store" } },
    );
  }
  return new Response("Not found", { status: 404 });
}
