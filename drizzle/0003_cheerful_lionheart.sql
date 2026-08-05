ALTER TABLE `stickers` ADD `display_code` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `stickers` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `stickers` ADD `type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `stickers` ADD `position` text;--> statement-breakpoint
ALTER TABLE `stickers` ADD `foil` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `stickers` ADD `source_url` text DEFAULT '' NOT NULL;