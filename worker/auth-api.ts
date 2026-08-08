type AuthEnv = { DB: D1Database };

const SESSION_COOKIE = "sticker_session";
const SESSION_DAYS = 30;
const ITERATIONS = 100000;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  return new Uint8Array(hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
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

function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? null;
}

export async function viewerFromSession(request: Request, db: D1Database) {
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const viewer = await db.prepare(
    `SELECT u.email, u.display_name AS displayName, u.is_admin AS isAdmin
     FROM sessions s JOIN users u ON u.email = s.user_email
     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_disabled = 0`,
  ).bind(tokenHash).first<{ email: string; displayName: string; isAdmin: number }>();
  return viewer ? { ...viewer, isAdmin: Boolean(viewer.isAdmin) } : null;
}

async function createSession(db: D1Database, email: string) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(tokenBytes);
  const tokenHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.prepare("INSERT INTO sessions (token_hash, user_email, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, email, expires.toISOString()).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function enforceRateLimit(db: D1Database, key: string, maximum: number, windowMinutes: number) {
  const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const current = await db.prepare("SELECT attempts, window_started_at AS windowStartedAt FROM auth_rate_limits WHERE rate_key = ?").bind(key).first<{ attempts: number; windowStartedAt: string }>();
  if (!current || current.windowStartedAt < cutoff) {
    await db.prepare("INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at) VALUES (?, 1, CURRENT_TIMESTAMP) ON CONFLICT(rate_key) DO UPDATE SET attempts = 1, window_started_at = CURRENT_TIMESTAMP").bind(key).run();
    return null;
  }
  if (current.attempts >= maximum) return Response.json({ error: "Too many attempts. Please wait and try again." }, { status: 429, headers: { "Retry-After": String(windowMinutes * 60) } });
  await db.prepare("UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?").bind(key).run();
  return null;
}

async function verifyPassword(db: D1Database, email: string, password: string) {
  const user = await db.prepare("SELECT email, display_name AS displayName, password_hash AS passwordHash, password_salt AS passwordSalt, is_disabled AS isDisabled FROM users WHERE email = ?")
    .bind(email).first<{ email: string; displayName: string; passwordHash: string | null; passwordSalt: string | null; isDisabled: number }>();
  if (!user?.passwordHash || !user.passwordSalt || user.isDisabled) return null;
  return safeEqual(await hashPassword(password, hexToBytes(user.passwordSalt)), user.passwordHash) ? user : null;
}

export async function handleAuthRequest(request: Request, env: AuthEnv) {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/session") {
    const viewer = await viewerFromSession(request, env.DB);
    return viewer ? Response.json({ viewer }) : Response.json({ error: "Signed out" }, { status: 401 });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = sessionToken(request);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  }

  if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
    const viewer = await viewerFromSession(request, env.DB);
    if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });
    const body = await request.json() as { currentPassword?: string; newPassword?: string };
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 10 || body.newPassword.length > 128) return Response.json({ error: "New password must be 10 to 128 characters" }, { status: 400 });
    if (!await verifyPassword(env.DB, viewer.email, body.currentPassword)) return Response.json({ error: "Current password is incorrect" }, { status: 401 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
      .bind(await hashPassword(body.newPassword, salt), bytesToHex(salt), viewer.email).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(viewer.email).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": await createSession(env.DB, viewer.email) } });
  }

  if (url.pathname === "/api/auth/delete-account" && request.method === "POST") {
    const viewer = await viewerFromSession(request, env.DB);
    if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });
    const body = await request.json() as { password?: string; confirmation?: string };
    if (body.confirmation !== "DELETE" || !body.password || !await verifyPassword(env.DB, viewer.email, body.password)) return Response.json({ error: "Password or confirmation is incorrect" }, { status: 400 });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM trade_history_items WHERE history_id IN (SELECT id FROM trade_history WHERE user_email = ?)").bind(viewer.email),
      env.DB.prepare("DELETE FROM trade_history WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM user_collections WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(viewer.email),
      env.DB.prepare("DELETE FROM users WHERE email = ?").bind(viewer.email),
    ]);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  }

  if (url.pathname === "/api/auth/manual-reset" && request.method === "POST") {
    const body = await request.json() as { email?: string; resetCode?: string; newPassword?: string };
    const email = body.email?.trim().toLowerCase() ?? "";
    const code = body.resetCode?.trim() ?? "";
    const password = body.newPassword ?? "";
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limited = await enforceRateLimit(env.DB, `reset:${ip}:${email}`, 5, 30);
    if (limited) return limited;
    if (!/^\S+@\S+\.\S+$/.test(email) || code.length < 16 || password.length < 10 || password.length > 128) return Response.json({ error: "Check the email, reset code, and new password" }, { status: 400 });
    const reset = await env.DB.prepare("SELECT reset_code AS resetCode FROM manual_password_resets WHERE user_email = ? AND expires_at > CURRENT_TIMESTAMP").bind(email).first<{ resetCode: string }>();
    if (!reset || !safeEqual(code, reset.resetCode)) return Response.json({ error: "Reset code is invalid or expired" }, { status: 400 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(await hashPassword(password, salt), bytesToHex(salt), email),
      env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(email),
      env.DB.prepare("DELETE FROM manual_password_resets WHERE user_email = ?").bind(email),
    ]);
    return Response.json({ ok: true });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.json() as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  if (password.length < 10 || password.length > 128) return Response.json({ error: "Password must be 10 to 128 characters" }, { status: 400 });

  if (url.pathname === "/api/auth/signup") {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limited = await enforceRateLimit(env.DB, `signup:${ip}`, 5, 60);
    if (limited) return limited;
    const existing = await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(email).first();
    if (existing) return Response.json({ error: "An account already exists for this email" }, { status: 409 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await hashPassword(password, salt);
    await env.DB.prepare("INSERT INTO users (email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)")
      .bind(email, email, passwordHash, bytesToHex(salt)).run();
    return Response.json({ viewer: { email, displayName: email } }, { headers: { "Set-Cookie": await createSession(env.DB, email) } });
  }

  if (url.pathname === "/api/auth/login") {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limited = await enforceRateLimit(env.DB, `login:${ip}:${email}`, 8, 15);
    if (limited) return limited;
    const user = await verifyPassword(env.DB, email, password);
    if (!user) {
      return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    }
    return Response.json({ viewer: { email: user.email, displayName: user.displayName } }, { headers: { "Set-Cookie": await createSession(env.DB, email) } });
  }
  return new Response("Not found", { status: 404 });
}
