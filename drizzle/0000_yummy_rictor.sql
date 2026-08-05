CREATE TABLE `album_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`album_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`flag` text DEFAULT '' NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`year` integer NOT NULL,
	`total_stickers` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `albums_slug_unique` ON `albums` (`slug`);--> statement-breakpoint
CREATE TABLE `stickers` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`code` text NOT NULL,
	`number` integer NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `album_sections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stickers_code_unique` ON `stickers` (`code`);--> statement-breakpoint
CREATE TABLE `user_collections` (
	`user_email` text NOT NULL,
	`sticker_id` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_email`, `sticker_id`),
	FOREIGN KEY (`user_email`) REFERENCES `users`(`email`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sticker_id`) REFERENCES `stickers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
