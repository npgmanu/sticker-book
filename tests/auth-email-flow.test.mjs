import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAuthRequest } from "../worker/auth-api.ts";

class D1StatementMock {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new D1StatementMock(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: result.changes } };
  }
}

class D1Mock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      email TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE auth_rate_limits (
      rate_key TEXT PRIMARY KEY NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      window_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_verification_status (
      user_email TEXT PRIMARY KEY NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      required INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_collections (user_email TEXT NOT NULL, sticker_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trade_basket_items (user_email TEXT NOT NULL, sticker_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE trade_history (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, total_stickers INTEGER NOT NULL);
    CREATE TABLE trade_history_items (history_id TEXT NOT NULL, sticker_id TEXT NOT NULL, quantity INTEGER NOT NULL);
    CREATE TABLE manual_password_resets (user_email TEXT PRIMARY KEY, reset_code TEXT NOT NULL, expires_at TEXT NOT NULL);
  `);
  return { sqlite, d1: new D1Mock(sqlite) };
}

function request(path, body, cookie = "") {
  const headers = { "content-type": "application/json", origin: "https://stickers.example.com", "cf-connecting-ip": "203.0.113.42" };
  if (cookie) headers.cookie = cookie;
  return new Request(`https://stickers.example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function emailLink(message, parameter) {
  const payload = JSON.parse(message.body);
  const match = payload.text.match(/https:\/\/[^\s]+/);
  assert.ok(match, "transactional email contains an HTTPS link");
  const link = new URL(match[0]);
  assert.equal(link.origin, "https://stickers.example.com");
  return link.searchParams.get(parameter);
}

test("verification and self-service password reset preserve existing data", async () => {
  const { sqlite, d1 } = testDatabase();
  const sentEmails = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.headers.authorization, "Bearer test-secret-key");
    sentEmails.push({ body: init.body, headers: init.headers });
    return Response.json({ id: `email-${sentEmails.length}` });
  };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const env = {
    DB: d1,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-secret-key",
    EMAIL_FROM: "Sticker Book <accounts@example.com>",
    SUPPORT_EMAIL: "support@example.com",
    APP_URL: "https://stickers.example.com",
  };

  try {
    const signup = await handleAuthRequest(request("/api/auth/signup", { email: "new@example.com", password: "first-password-123" }), env, ctx);
    assert.equal(signup.status, 201);
    assert.deepEqual(await signup.json(), { ok: true, email: "new@example.com", verificationRequired: true, emailSent: true });
    assert.equal(sentEmails.length, 1);
    const firstVerificationToken = emailLink(sentEmails[0], "verify");
    assert.match(firstVerificationToken, /^[a-f0-9]{64}$/);
    const storedVerification = sqlite.prepare("SELECT token_hash AS tokenHash FROM auth_tokens WHERE user_email = ?").get("new@example.com");
    assert.notEqual(storedVerification.tokenHash, firstVerificationToken);

    const blockedLogin = await handleAuthRequest(request("/api/auth/login", { email: "new@example.com", password: "first-password-123" }), env, ctx);
    assert.equal(blockedLogin.status, 403);
    assert.equal((await blockedLogin.json()).code, "EMAIL_VERIFICATION_REQUIRED");

    sqlite.prepare("UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_email = ?").run("new@example.com");
    const expiredVerification = await handleAuthRequest(request("/api/auth/verify-email", { token: firstVerificationToken }), env, ctx);
    assert.equal(expiredVerification.status, 400, "expired verification token is rejected");
    const resendVerification = await handleAuthRequest(request("/api/auth/resend-verification", { email: "new@example.com" }), env, ctx);
    assert.equal(resendVerification.status, 200);
    const verificationToken = emailLink(sentEmails.at(-1), "verify");
    const verified = await handleAuthRequest(request("/api/auth/verify-email", { token: verificationToken }), env, ctx);
    assert.equal(verified.status, 200);
    const sessionCookie = verified.headers.get("set-cookie").split(";")[0];
    assert.ok(sessionCookie.startsWith("sticker_session="));
    const verifiedAgain = await handleAuthRequest(request("/api/auth/verify-email", { token: verificationToken }), env, ctx);
    assert.equal(verifiedAgain.status, 400, "verification token is single use");

    const session = await handleAuthRequest(new Request("https://stickers.example.com/api/auth/session", { headers: { cookie: sessionCookie } }), env, ctx);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).viewer.emailVerified, true);

    sqlite.prepare("INSERT INTO user_collections (user_email, sticker_id, quantity) VALUES (?, ?, ?)").run("new@example.com", "USA-04", 3);
    sqlite.prepare("INSERT INTO trade_basket_items (user_email, sticker_id, quantity) VALUES (?, ?, ?)").run("new@example.com", "USA-04", 1);
    sqlite.prepare("INSERT INTO trade_history (id, user_email, total_stickers) VALUES (?, ?, ?)").run("history-1", "new@example.com", 1);

    const forgot = await handleAuthRequest(request("/api/auth/forgot-password", { email: "new@example.com" }), env, ctx);
    const forgotMissing = await handleAuthRequest(request("/api/auth/forgot-password", { email: "missing@example.com" }), env, ctx);
    assert.equal((await forgot.json()).message, (await forgotMissing.json()).message, "forgot password is neutral");
    const resetToken = emailLink(sentEmails.at(-1), "reset");
    assert.match(resetToken, /^[a-f0-9]{64}$/);

    const reset = await handleAuthRequest(request("/api/auth/reset-password", { token: resetToken, newPassword: "second-password-456" }), env, ctx);
    assert.equal(reset.status, 200);
    await Promise.all(pending);
    assert.equal(JSON.parse(sentEmails.at(-1).body).subject, "Your Sticker Book password was changed");
    const reusedReset = await handleAuthRequest(request("/api/auth/reset-password", { token: resetToken, newPassword: "third-password-789" }), env, ctx);
    assert.equal(reusedReset.status, 400, "reset token is single use");

    const oldLogin = await handleAuthRequest(request("/api/auth/login", { email: "new@example.com", password: "first-password-123" }), env, ctx);
    assert.equal(oldLogin.status, 401);
    const newLogin = await handleAuthRequest(request("/api/auth/login", { email: "new@example.com", password: "second-password-456" }), env, ctx);
    assert.equal(newLogin.status, 200);
    assert.equal(sqlite.prepare("SELECT quantity FROM user_collections WHERE user_email = ? AND sticker_id = ?").get("new@example.com", "USA-04").quantity, 3);
    assert.equal(sqlite.prepare("SELECT quantity FROM trade_basket_items WHERE user_email = ? AND sticker_id = ?").get("new@example.com", "USA-04").quantity, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM trade_history WHERE user_email = ?").get("new@example.com").count, 1);

    assert.equal((await handleAuthRequest(request("/api/auth/forgot-password", { email: "new@example.com" }), env, ctx)).status, 200);
    assert.equal((await handleAuthRequest(request("/api/auth/forgot-password", { email: "new@example.com" }), env, ctx)).status, 200);
    assert.equal((await handleAuthRequest(request("/api/auth/forgot-password", { email: "new@example.com" }), env, ctx)).status, 429, "address-level email rate limit is enforced");

    const legacySignup = await handleAuthRequest(request("/api/auth/signup", { email: "existing@example.com", password: "existing-password-123" }), env, ctx);
    assert.equal(legacySignup.status, 201);
    sqlite.prepare("DELETE FROM auth_tokens WHERE user_email = ?").run("existing@example.com");
    sqlite.prepare("DELETE FROM email_verification_status WHERE user_email = ?").run("existing@example.com");
    const legacyLogin = await handleAuthRequest(request("/api/auth/login", { email: "existing@example.com", password: "existing-password-123" }), env, ctx);
    assert.equal(legacyLogin.status, 200, "an account without a verification row remains usable");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
