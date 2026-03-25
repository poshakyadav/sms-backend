CREATE TABLE `notification_interactions` (
	`notification_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`read_at` text,
	`is_archived` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`notification_id`, `user_id`),
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `notification_reads`;--> statement-breakpoint
ALTER TABLE `notifications` ADD `target_type` text NOT NULL;--> statement-breakpoint
CREATE INDEX `target_idx` ON `notifications` (`target_type`,`class_id`,`section_id`);--> statement-breakpoint
CREATE INDEX `created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `type`;