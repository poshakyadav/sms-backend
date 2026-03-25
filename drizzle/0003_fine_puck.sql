ALTER TABLE `turso_databases` ADD `last_migration_at` text DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `turso_databases` ADD `created_by_email` text NOT NULL;