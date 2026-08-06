import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  onboardingCompleted: integer("onboarding_completed", { mode: "boolean" }).notNull().default(false),
  activeAlbumId: text("active_album_id"),
  setupMethod: text("setup_method"),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userEmail: text("user_email").notNull().references(() => users.email, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const albums = sqliteTable("albums", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  year: integer("year").notNull(),
  totalStickers: integer("total_stickers").notNull(),
});

export const albumSections = sqliteTable("album_sections", {
  id: text("id").primaryKey(),
  albumId: text("album_id").notNull().references(() => albums.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  flag: text("flag").notNull().default(""),
  sortOrder: integer("sort_order").notNull(),
});

export const stickers = sqliteTable("stickers", {
  id: text("id").primaryKey(),
  sectionId: text("section_id").notNull().references(() => albumSections.id),
  code: text("code").notNull().unique(),
  displayCode: text("display_code").notNull().default(""),
  number: integer("number").notNull(),
  sortOrder: integer("sort_order").notNull(),
  name: text("name").notNull().default(""),
  type: text("type").notNull().default(""),
  position: text("position"),
  foil: integer("foil", { mode: "boolean" }).notNull().default(false),
  sourceUrl: text("source_url").notNull().default(""),
});

export const userCollections = sqliteTable(
  "user_collections",
  {
    userEmail: text("user_email").notNull().references(() => users.email),
    stickerId: text("sticker_id").notNull().references(() => stickers.id),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.userEmail, table.stickerId] })],
);

export const tradeBasketItems = sqliteTable(
  "trade_basket_items",
  {
    userEmail: text("user_email").notNull().references(() => users.email),
    stickerId: text("sticker_id").notNull().references(() => stickers.id),
    quantity: integer("quantity").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.userEmail, table.stickerId] })],
);

export const tradeHistory = sqliteTable("trade_history", {
  id: text("id").primaryKey(),
  userEmail: text("user_email").notNull().references(() => users.email),
  label: text("label").notNull().default("Manual Trade"),
  totalStickers: integer("total_stickers").notNull(),
  completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const tradeHistoryItems = sqliteTable(
  "trade_history_items",
  {
    historyId: text("history_id").notNull().references(() => tradeHistory.id, { onDelete: "cascade" }),
    stickerId: text("sticker_id").notNull().references(() => stickers.id),
    quantity: integer("quantity").notNull(),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull().default("outgoing"),
  },
  (table) => [primaryKey({ columns: [table.historyId, table.stickerId] })],
);
