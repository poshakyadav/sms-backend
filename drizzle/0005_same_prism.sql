DROP INDEX "super_users_email_unique";--> statement-breakpoint
DROP INDEX "refresh_tokens_token_unique";--> statement-breakpoint
DROP INDEX "turso_databases_url_unique";--> statement-breakpoint
DROP INDEX "schools_unique_code_unique";--> statement-breakpoint
DROP INDEX "schools_email_unique";--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "address_line_one" TO "address_line_one" text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE UNIQUE INDEX `super_users_email_unique` ON `super_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_unique` ON `refresh_tokens` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `turso_databases_url_unique` ON `turso_databases` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `schools_unique_code_unique` ON `schools` (`unique_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `schools_email_unique` ON `schools` (`email`);--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "address_line_two" TO "address_line_two" text DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "phone" TO "phone" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `schools` ALTER COLUMN "alternate_phone" TO "alternate_phone" text DEFAULT '';