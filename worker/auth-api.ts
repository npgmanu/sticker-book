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
  return db.prepare(
    `SELECT u.email, u.display_name AS displayName
     FROM sessions s JOIN users u ON u.email = s.user_email
     WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`,
  ).bind(tokenHash).first<{ email: string; displayName: string }>();
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

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await request.json() as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  if (password.length < 10 || password.length > 128) return Response.json({ error: "Password must be 10 to 128 characters" }, { status: 400 });

  if (url.pathname === "/api/auth/signup") {
    const existing = await env.DB.prepare("SELECT email FROM users WHERE email = ?").bind(email).first();
    if (existing) return Response.json({ error: "An account already exists for this email" }, { status: 409 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await hashPassword(password, salt);
    await env.DB.prepare("INSERT INTO users (email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?)")
      .bind(email, email, passwordHash, bytesToHex(salt)).run();
    return Response.json({ viewer: { email, displayName: email } }, { headers: { "Set-Cookie": await createSession(env.DB, email) } });
  }

  if (url.pathname === "/api/auth/login") {
    const user = await env.DB.prepare("SELECT email, display_name AS displayName, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE email = ?")
      .bind(email).first<{ email: string; displayName: string; passwordHash: string | null; passwordSalt: string | null }>();
    if (!user?.passwordHash || !user.passwordSalt || !safeEqual(await hashPassword(password, hexToBytes(user.passwordSalt)), user.passwordHash)) {
      return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    }
    return Response.json({ viewer: { email: user.email, displayName: user.displayName } }, { headers: { "Set-Cookie": await createSession(env.DB, email) } });
  }
  return new Response("Not found", { status: 404 });
}
