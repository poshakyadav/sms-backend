DROP INDEX `uq_active_theme_per_school`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_school_active_theme` ON `school_theme_configs` (`school_id`) WHERE "school_theme_configs"."is_active" = 1;