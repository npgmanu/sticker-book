import { viewerFromSession } from "./auth-api";

type AdminEnv = { DB: D1Database };

function randomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(request: Request, db: D1Database) {
  const viewer = await viewerFromSession(request, db);
  return viewer?.isAdmin ? viewer : null;
}

async function targetUser(db: D1Database, email: string) {
  return db.prepare("SELECT email, is_admin AS isAdmin FROM users WHERE email = ?").bind(email).first<{ email: string; isAdmin: number }>();
}

export async function handleAdminRequest(request: Request, env: AdminEnv) {
  const admin = await requireAdmin(request, env.DB);
  if (!admin) return Response.json({ error: "Admin access required" }, { status: 403 });

  try {
    if (request.method === "GET") {
      const result = await env.DB.prepare(
        `SELECT u.email,
                u.display_name AS displayName,
                u.onboarding_completed AS onboardingCompleted,
                u.is_admin AS isAdmin,
                u.is_disabled AS isDisabled,
                u.created_at AS createdAt,
                u.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_email = u.email AND s.expires_at > CURRENT_TIMESTAMP) AS activeSessions,
                (SELECT COUNT(*) FROM user_collections c WHERE c.user_email = u.email AND c.quantity > 0) AS collected,
                (SELECT COALESCE(SUM(CASE WHEN c.quantity > 1 THEN c.quantity - 1 ELSE 0 END), 0) FROM user_collections c WHERE c.user_email = u.email) AS extras
         FROM users u
         ORDER BY u.created_at DESC, u.email ASC`,
      ).all<{
        email: string;
        displayName: string;
        onboardingCompleted: number;
        isAdmin: number;
        isDisabled: number;
        createdAt: string;
        updatedAt: string;
        activeSessions: number;
        collected: number;
        extras: number;
      }>();

      return Response.json({
        users: result.results.map((user) => ({
          ...user,
          onboardingCompleted: Boolean(user.onboardingCompleted),
          isDisabled: Boolean(user.isDisabled),
          isAdmin: Boolean(user.isAdmin),
        })),
      });
    }

    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = await request.json() as { action?: string; email?: string };
    const action = body.action?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";
    const target = /^\S+@\S+\.\S+$/.test(email) ? await targetUser(env.DB, email) : null;
    if (!target) {
      return Response.json({ error: "Choose an existing account" }, { status: 400 });
    }
    if (target.isAdmin && ["disable", "delete", "signout"].includes(action)) {
      return Response.json({ error: "The owner account cannot be disabled, deleted, or signed out here" }, { status: 400 });
    }

    if (action === "reset") {
      const resetCode = randomCode();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await env.DB.prepare(
        `INSERT INTO manual_password_resets (user_email, reset_code, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_email) DO UPDATE SET
           reset_code = excluded.reset_code,
           expires_at = excluded.expires_at,
           created_at = CURRENT_TIMESTAMP`,
      ).bind(email, resetCode, expiresAt).run();
      return Response.json({ ok: true, resetCode, expiresAt });
    }

    if (action === "signout") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(email).run();
      return Response.json({ ok: true });
    }

    if (action === "disable") {
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET is_disabled = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(email),
        env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(email),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "enable") {
      await env.DB.prepare("UPDATE users SET is_disabled = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(email).run();
      return Response.json({ ok: true });
    }

    if (action === "delete") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ?").bind(email),
        env.DB.prepare("DELETE FROM trade_history_items WHERE history_id IN (SELECT id FROM trade_history WHERE user_email = ?)").bind(email),
        env.DB.prepare("DELETE FROM trade_history WHERE user_email = ?").bind(email),
        env.DB.prepare("DELETE FROM user_collections WHERE user_email = ?").bind(email),
        env.DB.prepare("DELETE FROM sessions WHERE user_email = ?").bind(email),
        env.DB.prepare("DELETE FROM manual_password_resets WHERE user_email = ?").bind(email),
        env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email),
      ]);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Unknown admin action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin request failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
