import { catalogStickers } from "../app/catalog";
import { ensureCatalogAndCollector, readCollection, viewerFromRequest } from "./collection-api";

type TradeEnv = { DB: D1Database };

async function readBasket(db: D1Database, email: string) {
  const result = await db
    .prepare("SELECT sticker_id AS stickerId, quantity FROM trade_basket_items WHERE user_email = ?")
    .bind(email)
    .all<{ stickerId: string; quantity: number }>();
  return Object.fromEntries(result.results.map((row) => [row.stickerId, row.quantity]));
}

async function readHistory(db: D1Database, email: string) {
  const historyResult = await db
    .prepare(
      `SELECT id, label, total_stickers AS totalStickers, completed_at AS completedAt
       FROM trade_history WHERE user_email = ? ORDER BY completed_at DESC LIMIT 10`,
    )
    .bind(email)
    .all<{ id: string; label: string; totalStickers: number; completedAt: string }>();
  const entries = [];
  for (const history of historyResult.results) {
    const itemResult = await db
      .prepare("SELECT sticker_id AS code, quantity FROM trade_history_items WHERE history_id = ? ORDER BY sticker_id")
      .bind(history.id)
      .all<{ code: string; quantity: number }>();
    entries.push({ ...history, items: itemResult.results });
  }
  return entries;
}

export async function handleTradeRequest(request: Request, env: TradeEnv) {
  const viewer = viewerFromRequest(request);
  if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });

  try {
    await ensureCatalogAndCollector(env.DB, viewer.email, viewer.displayName);
    if (request.method === "GET") {
      return Response.json({
        basket: await readBasket(env.DB, viewer.email),
        history: await readHistory(env.DB, viewer.email),
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = (await request.json()) as {
      action?: "basket_adjust" | "clear" | "complete" | "undo" | "traded_one";
      code?: string;
      delta?: number;
      historyId?: string;
    };
    const code = body.code?.trim().toUpperCase() ?? "";
    const validCodes = new Set(catalogStickers.map((sticker) => sticker.code));

    if (body.action === "basket_adjust") {
      if (!validCodes.has(code) || (body.delta !== 1 && body.delta !== -1)) {
        return Response.json({ error: "Choose a valid extra" }, { status: 400 });
      }
      const inventory = await env.DB
        .prepare(
          `SELECT c.quantity, COALESCE(b.quantity, 0) AS reserved
           FROM user_collections c
           LEFT JOIN trade_basket_items b ON b.user_email = c.user_email AND b.sticker_id = c.sticker_id
           WHERE c.user_email = ? AND c.sticker_id = ?`,
        )
        .bind(viewer.email, code)
        .first<{ quantity: number; reserved: number }>();
      const extras = Math.max(0, (inventory?.quantity ?? 0) - 1);
      const current = inventory?.reserved ?? 0;
      const next = Math.max(0, Math.min(extras, current + body.delta));
      if (body.delta === 1 && next === current) {
        return Response.json({ error: "No unreserved extras are available" }, { status: 409 });
      }
      if (next === 0) {
        await env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ? AND sticker_id = ?").bind(viewer.email, code).run();
      } else {
        await env.DB
          .prepare(
            `INSERT INTO trade_basket_items (user_email, sticker_id, quantity)
             VALUES (?, ?, ?)
             ON CONFLICT(user_email, sticker_id)
             DO UPDATE SET quantity = excluded.quantity, updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(viewer.email, code, next)
          .run();
      }
      return Response.json({ basket: await readBasket(env.DB, viewer.email) });
    }

    if (body.action === "traded_one") {
      if (!validCodes.has(code)) return Response.json({ error: "Choose a valid extra" }, { status: 400 });
      const inventory = await env.DB
        .prepare(
          `SELECT c.quantity, COALESCE(b.quantity, 0) AS reserved
           FROM user_collections c
           LEFT JOIN trade_basket_items b ON b.user_email = c.user_email AND b.sticker_id = c.sticker_id
           WHERE c.user_email = ? AND c.sticker_id = ?`,
        )
        .bind(viewer.email, code)
        .first<{ quantity: number; reserved: number }>();
      const available = Math.max(0, (inventory?.quantity ?? 0) - 1 - (inventory?.reserved ?? 0));
      if (available < 1) return Response.json({ error: "No unreserved extras are available" }, { status: 409 });
      await env.DB
        .prepare(
          `UPDATE user_collections SET quantity = MAX(1, quantity - 1), updated_at = CURRENT_TIMESTAMP
           WHERE user_email = ? AND sticker_id = ?`,
        )
        .bind(viewer.email, code)
        .run();
      return Response.json({ collection: await readCollection(env.DB, viewer.email) });
    }

    if (body.action === "clear") {
      await env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ?").bind(viewer.email).run();
      return Response.json({ basket: {} });
    }

    if (body.action === "complete") {
      const basketResult = await env.DB
        .prepare(
          `SELECT b.sticker_id AS code, b.quantity AS reserved, c.quantity AS owned
           FROM trade_basket_items b
           JOIN user_collections c ON c.user_email = b.user_email AND c.sticker_id = b.sticker_id
           WHERE b.user_email = ? ORDER BY b.sticker_id`,
        )
        .bind(viewer.email)
        .all<{ code: string; reserved: number; owned: number }>();
      if (!basketResult.results.length) return Response.json({ error: "The Trade Basket is empty" }, { status: 400 });
      if (basketResult.results.some((item) => item.reserved > Math.max(0, item.owned - 1))) {
        return Response.json({ error: "Your inventory changed. Review the Trade Basket again." }, { status: 409 });
      }
      const historyId = crypto.randomUUID();
      const total = basketResult.results.reduce((sum, item) => sum + item.reserved, 0);
      const statements = [
        env.DB.prepare("INSERT INTO trade_history (id, user_email, label, total_stickers) VALUES (?, ?, 'Manual Trade', ?)").bind(historyId, viewer.email, total),
        ...basketResult.results.map((item) => env.DB.prepare("INSERT INTO trade_history_items (history_id, sticker_id, quantity) VALUES (?, ?, ?)").bind(historyId, item.code, item.reserved)),
        ...basketResult.results.map((item) => env.DB.prepare("UPDATE user_collections SET quantity = MAX(1, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND sticker_id = ?").bind(item.reserved, viewer.email, item.code)),
        env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ?").bind(viewer.email),
      ];
      await env.DB.batch(statements);
      return Response.json({
        basket: {},
        collection: await readCollection(env.DB, viewer.email),
        history: await readHistory(env.DB, viewer.email),
        completed: { id: historyId, total },
      });
    }

    if (body.action === "undo") {
      const historyId = body.historyId?.trim() ?? "";
      const history = await env.DB
        .prepare(
          `SELECT id FROM trade_history
           WHERE id = ? AND user_email = ? AND completed_at >= datetime('now', '-5 minutes')`,
        )
        .bind(historyId, viewer.email)
        .first<{ id: string }>();
      if (!history) return Response.json({ error: "This trade can no longer be undone" }, { status: 409 });
      const items = await env.DB
        .prepare("SELECT sticker_id AS code, quantity FROM trade_history_items WHERE history_id = ?")
        .bind(historyId)
        .all<{ code: string; quantity: number }>();
      await env.DB.batch([
        ...items.results.map((item) => env.DB.prepare("UPDATE user_collections SET quantity = MIN(99, quantity + ?), updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND sticker_id = ?").bind(item.quantity, viewer.email, item.code)),
        env.DB.prepare("DELETE FROM trade_history_items WHERE history_id = ?").bind(historyId),
        env.DB.prepare("DELETE FROM trade_history WHERE id = ? AND user_email = ?").bind(historyId, viewer.email),
      ]);
      return Response.json({
        collection: await readCollection(env.DB, viewer.email),
        history: await readHistory(env.DB, viewer.email),
      });
    }

    return Response.json({ error: "Unknown trade action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected database error";
    return Response.json({ error: message }, { status: 500 });
  }
}
