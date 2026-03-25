ALTER TABLE `school_users` ADD `date_of_birth` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `gender` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `address_line_one` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `address_line_two` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `city` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `state` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `postal_code` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `blood_group` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `date_of_birth`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `gender`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `blood_group`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `address`;