ALTER TABLE `users` ADD `onboarding_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `active_album_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `setup_method` text;