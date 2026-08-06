-- Run this once in Cloudflare D1 database: sticker-book-db
-- It is safe to run before uploading the updated website files.

ALTER TABLE trade_history_items
ADD COLUMN direction TEXT NOT NULL DEFAULT 'outgoing';
