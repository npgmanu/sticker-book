import { activeAlbum, albumSections, catalogStickers } from "../app/catalog";
import { viewerFromSession } from "./auth-api";

type CollectionEnv = {
  DB: D1Database;
};

export const viewerFromRequest = viewerFromSession;

export async function ensureCatalogAndCollector(db: D1Database, email: string, displayName: string) {
  await db
    .prepare(
      `INSERT INTO albums (id, slug, title, year, total_stickers)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         title = excluded.title,
         year = excluded.year,
         total_stickers = excluded.total_stickers`,
    )
    .bind(activeAlbum.id, activeAlbum.slug, activeAlbum.title, activeAlbum.year, catalogStickers.length)
    .run();

  const catalogState = await db
    .prepare(
      `SELECT COUNT(*) AS stickerCount,
              MAX(CASE WHEN id = 'FWC-00' AND display_code = '00' THEN 1 ELSE 0 END) AS hasStickerZero
       FROM stickers
       WHERE section_id IN (SELECT id FROM album_sections WHERE album_id = ?)`,
    )
    .bind(activeAlbum.id)
    .first<{ stickerCount: number; hasStickerZero: number }>();
  const catalogIsCurrent =
    Number(catalogState?.stickerCount ?? 0) === catalogStickers.length &&
    Number(catalogState?.hasStickerZero ?? 0) === 1;

  if (!catalogIsCurrent) {
    const sectionStatements = albumSections.map((section, index) =>
      db
        .prepare(
          `INSERT INTO album_sections (id, album_id, code, name, flag, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             album_id = excluded.album_id,
             code = excluded.code,
             name = excluded.name,
             flag = excluded.flag,
             sort_order = excluded.sort_order`,
        )
        .bind(
          `${activeAlbum.id}:${section.code}`,
          activeAlbum.id,
          section.code,
          section.name,
          section.flag,
          index,
        ),
    );
    await db.batch(sectionStatements);

    const stickerStatements = catalogStickers.map((sticker) =>
      db
        .prepare(
          `INSERT INTO stickers
             (id, section_id, code, display_code, number, sort_order, name, type, position, foil, source_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             section_id = excluded.section_id,
             code = excluded.code,
             display_code = excluded.display_code,
             number = excluded.number,
             sort_order = excluded.sort_order,
             name = excluded.name,
             type = excluded.type,
             position = excluded.position,
             foil = excluded.foil,
             source_url = excluded.source_url`,
        )
        .bind(
          sticker.id,
          sticker.sectionId,
          sticker.code,
          sticker.displayCode,
          sticker.number,
          sticker.sortOrder,
          sticker.name,
          sticker.type,
          sticker.position,
          sticker.foil ? 1 : 0,
          sticker.sourceUrl,
        ),
    );
    for (let index = 0; index < stickerStatements.length; index += 75) {
      await db.batch(stickerStatements.slice(index, index + 75));
    }
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO users (email, display_name)
       VALUES (?, ?)`,
    )
    .bind(email, displayName)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO user_collections (user_email, sticker_id, quantity)
       SELECT ?, id, 0 FROM stickers`,
    )
    .bind(email)
    .run();
}

export async function readCollection(db: D1Database, email: string) {
  const result = await db
    .prepare(
      "SELECT sticker_id AS stickerId, quantity FROM user_collections WHERE user_email = ?",
    )
    .bind(email)
    .all<{ stickerId: string; quantity: number }>();
  return Object.fromEntries(result.results.map((row) => [row.stickerId, row.quantity]));
}

export async function handleAccountRequest(request: Request, env: CollectionEnv) {
  const viewer = await viewerFromRequest(request, env.DB);
  if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });

  try {
    await ensureCatalogAndCollector(env.DB, viewer.email, viewer.displayName);

    if (request.method === "GET") {
      const profile = await env.DB
        .prepare(
          `SELECT display_name AS displayName,
                  onboarding_completed AS onboardingCompleted,
                  active_album_id AS activeAlbumId,
                  setup_method AS setupMethod
           FROM users WHERE email = ?`,
        )
        .bind(viewer.email)
        .first<{
          displayName: string;
          onboardingCompleted: number;
          activeAlbumId: string | null;
          setupMethod: string | null;
        }>();
      return Response.json({
        profile: profile
          ? { ...profile, onboardingCompleted: Boolean(profile.onboardingCompleted) }
          : null,
      });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as {
        displayName?: string;
        albumId?: string;
        setupMethod?: string;
        missingCodes?: string[];
      };
      const displayName = body.displayName?.trim() ?? "";
      const albumId = body.albumId?.trim() ?? "";
      const setupMethod = body.setupMethod?.trim() ?? "";
      const allowedMethods = ["new", "already", "import"];

      if (!displayName || displayName.length > 40) {
        return Response.json({ error: "Display name must be 1 to 40 characters" }, { status: 400 });
      }
      if (albumId !== activeAlbum.id) {
        return Response.json({ error: "Choose a supported album" }, { status: 400 });
      }
      if (!allowedMethods.includes(setupMethod)) {
        return Response.json({ error: "Choose a collection setup method" }, { status: 400 });
      }

      const validCodes = new Set(catalogStickers.map((sticker) => sticker.code));
      const missingCodes = Array.from(
        new Set((body.missingCodes ?? []).map((code) => code.trim().toUpperCase())),
      );
      if (missingCodes.some((code) => !validCodes.has(code))) {
        return Response.json({ error: "The missing list contains an unknown sticker code" }, { status: 400 });
      }

      const startingQuantity = setupMethod === "new" ? 0 : 1;
      await env.DB
        .prepare(
          "UPDATE user_collections SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE user_email = ?",
        )
        .bind(startingQuantity, viewer.email)
        .run();

      if (startingQuantity === 1 && missingCodes.length) {
        const missingStatements = missingCodes.map((code) =>
          env.DB
            .prepare(
              "UPDATE user_collections SET quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND sticker_id = ?",
            )
            .bind(viewer.email, code),
        );
        for (let index = 0; index < missingStatements.length; index += 75) {
          await env.DB.batch(missingStatements.slice(index, index + 75));
        }
      }

      await env.DB
        .prepare(
          `UPDATE users
           SET display_name = ?, onboarding_completed = 1, active_album_id = ?, setup_method = ?, updated_at = CURRENT_TIMESTAMP
           WHERE email = ?`,
        )
        .bind(displayName, albumId, setupMethod, viewer.email)
        .run();

      return Response.json({
        profile: {
          displayName,
          onboardingCompleted: true,
          activeAlbumId: albumId,
          setupMethod,
        },
        collection: await readCollection(env.DB, viewer.email),
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected database error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function handleCollectionRequest(request: Request, env: CollectionEnv) {
  const viewer = await viewerFromRequest(request, env.DB);
  if (!viewer) return Response.json({ error: "Sign in required" }, { status: 401 });

  try {
    await ensureCatalogAndCollector(env.DB, viewer.email, viewer.displayName);

    if (request.method === "GET") {
      return Response.json({
        album: activeAlbum,
        collection: await readCollection(env.DB, viewer.email),
      });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as {
        code?: string;
        quantity?: number;
        action?: "increment" | "decrement" | "import_missing" | "import_extras";
        albumId?: string;
        missingCodes?: string[];
        extras?: { code?: string; quantity?: number }[];
      };
      const code = body.code?.trim().toUpperCase() ?? "";
      const quantity = body.quantity;

      if (body.action === "import_missing") {
        if (body.albumId !== activeAlbum.id) {
          return Response.json({ error: "Choose a supported album" }, { status: 400 });
        }
        const validCodes = new Set(catalogStickers.map((sticker) => sticker.code));
        const missingCodes = Array.from(
          new Set((body.missingCodes ?? []).map((missingCode) => missingCode.trim().toUpperCase())),
        );
        if (missingCodes.some((missingCode) => !validCodes.has(missingCode))) {
          return Response.json({ error: "The import contains an unknown sticker code" }, { status: 400 });
        }

        await env.DB
          .prepare(
            `UPDATE user_collections
             SET quantity = CASE WHEN quantity > 1 THEN quantity ELSE 1 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_email = ?`,
          )
          .bind(viewer.email)
          .run();

        if (missingCodes.length) {
          const missingStatements = missingCodes.map((missingCode) =>
            env.DB
              .prepare(
                `UPDATE user_collections
                 SET quantity = 0, updated_at = CURRENT_TIMESTAMP
                 WHERE user_email = ? AND sticker_id = ? AND quantity <= 1`,
              )
              .bind(viewer.email, missingCode),
          );
          for (let index = 0; index < missingStatements.length; index += 75) {
            await env.DB.batch(missingStatements.slice(index, index + 75));
          }
        }

        return Response.json({
          importedMissing: missingCodes.length,
          collection: await readCollection(env.DB, viewer.email),
        });
      }

      if (body.action === "import_extras") {
        if (body.albumId !== activeAlbum.id) {
          return Response.json({ error: "Choose a supported album" }, { status: 400 });
        }
        if (!Array.isArray(body.extras) || body.extras.length < 1 || body.extras.length > catalogStickers.length) {
          return Response.json({ error: "Add at least one valid extra" }, { status: 400 });
        }
        const validCodes = new Set(catalogStickers.map((sticker) => sticker.code));
        const extrasByCode = new Map<string, number>();
        for (const item of body.extras) {
          const extraCode = item.code?.trim().toUpperCase() ?? "";
          const extraQuantity = item.quantity;
          if (!validCodes.has(extraCode) || !Number.isInteger(extraQuantity) || extraQuantity === undefined || extraQuantity < 1 || extraQuantity > 98) {
            return Response.json({ error: "The duplicate list contains an invalid sticker or quantity" }, { status: 400 });
          }
          extrasByCode.set(extraCode, Math.max(extrasByCode.get(extraCode) ?? 0, extraQuantity));
        }

        const previousCollection = await readCollection(env.DB, viewer.email);
        const extraStatements = Array.from(extrasByCode, ([extraCode, extraQuantity]) =>
          env.DB
            .prepare(
              `UPDATE user_collections
               SET quantity = MAX(quantity, MIN(99, 1 + ?)), updated_at = CURRENT_TIMESTAMP
               WHERE user_email = ? AND sticker_id = ?`,
            )
            .bind(extraQuantity, viewer.email, extraCode),
        );
        for (let index = 0; index < extraStatements.length; index += 75) {
          await env.DB.batch(extraStatements.slice(index, index + 75));
        }
        const nextCollection = await readCollection(env.DB, viewer.email);
        let importedExtras = 0;
        let updatedStickers = 0;
        extrasByCode.forEach((_quantity, extraCode) => {
          const previous = previousCollection[extraCode] ?? 0;
          const next = nextCollection[extraCode] ?? 0;
          importedExtras += Math.max(0, Math.max(0, next - 1) - Math.max(0, previous - 1));
          if (next > previous) updatedStickers += 1;
        });

        return Response.json({
          importedExtras,
          updatedStickers,
          collection: nextCollection,
        });
      }

      if (!catalogStickers.some((sticker) => sticker.code === code)) {
        return Response.json({ error: "Unknown sticker code" }, { status: 400 });
      }

      if (body.action === "increment" || body.action === "decrement") {
        const operator = body.action === "increment" ? "+" : "-";
        const boundary = body.action === "increment" ? "MIN" : "MAX";
        const limit = body.action === "increment" ? 99 : 0;
        const updated = await env.DB
          .prepare(
            `UPDATE user_collections
             SET quantity = ${boundary}(quantity ${operator} 1, ?), updated_at = CURRENT_TIMESTAMP
             WHERE user_email = ? AND sticker_id = ?
             RETURNING quantity`,
          )
          .bind(limit, viewer.email, code)
          .first<{ quantity: number }>();
        return Response.json({ code, quantity: updated?.quantity ?? 0 });
      }

      if (!Number.isInteger(quantity) || quantity === undefined || quantity < 0 || quantity > 99) {
        return Response.json({ error: "Quantity must be between 0 and 99" }, { status: 400 });
      }

      if (quantity > 0) {
        const reserved = await env.DB
          .prepare("SELECT quantity FROM trade_basket_items WHERE user_email = ? AND sticker_id = ?")
          .bind(viewer.email, code)
          .first<{ quantity: number }>();
        if (quantity < (reserved?.quantity ?? 0) + 1) {
          return Response.json({ error: "Remove reserved copies from the Trade Basket first" }, { status: 409 });
        }
      } else {
        await env.DB.prepare("DELETE FROM trade_basket_items WHERE user_email = ? AND sticker_id = ?").bind(viewer.email, code).run();
      }

      await env.DB
        .prepare(
          `INSERT INTO user_collections (user_email, sticker_id, quantity)
           VALUES (?, ?, ?)
           ON CONFLICT(user_email, sticker_id)
           DO UPDATE SET quantity = excluded.quantity, updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(viewer.email, code, quantity)
        .run();
      return Response.json({ code, quantity });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected database error";
    return Response.json({ error: message }, { status: 500 });
  }
}
