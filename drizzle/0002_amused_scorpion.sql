ALTER TABLE `schools` ADD `email` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `schools_email_unique` ON `schools` (`email`);