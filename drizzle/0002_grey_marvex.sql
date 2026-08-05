CREATE TABLE `trade_basket_items` (
	`user_email` text NOT NULL,
	`sticker_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_email`, `sticker_id`),
	FOREIGN KEY (`user_email`) REFERENCES `users`(`email`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sticker_id`) REFERENCES `stickers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trade_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`label` text DEFAULT 'Manual Trade' NOT NULL,
	`total_stickers` integer NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_email`) REFERENCES `users`(`email`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trade_history_items` (
	`history_id` text NOT NULL,
	`sticker_id` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`history_id`, `sticker_id`),
	FOREIGN KEY (`history_id`) REFERENCES `trade_history`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sticker_id`) REFERENCES `stickers`(`id`) ON UPDATE no action ON DELETE no action
);
