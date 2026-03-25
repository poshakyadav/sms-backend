DROP INDEX "school_users_email_unique";--> statement-breakpoint
DROP INDEX "schools_unique_code_unique";--> statement-breakpoint
DROP INDEX "refresh_tokens_token_unique";--> statement-breakpoint
DROP INDEX "subjects_code_unique";--> statement-breakpoint
DROP INDEX "fee_payments_receipt_number_unique";--> statement-breakpoint
ALTER TABLE `school_users` ALTER COLUMN "phone" TO "phone" text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `school_users_email_unique` ON `school_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `schools_unique_code_unique` ON `schools` (`unique_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_unique` ON `refresh_tokens` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_code_unique` ON `subjects` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `fee_payments_receipt_number_unique` ON `fee_payments` (`receipt_number`);--> statement-breakpoint
ALTER TABLE `school_users` ALTER COLUMN "avatar_url" TO "avatar_url" text DEFAULT '';--> statement-breakpoint
ALTER TABLE `school_users` ADD `alternate_phone` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "phone" TO "phone" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "email" TO "email" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "website" TO "website" text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "logo_url" TO "logo_url" text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "tagline" TO "tagline" text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ADD `address_line_one` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `schools` ADD `address_line_two` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ADD `alternate_phone` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` DROP COLUMN `address`;