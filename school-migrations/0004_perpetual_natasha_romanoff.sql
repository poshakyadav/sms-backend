ALTER TABLE `notifications` ADD `section_id` integer;--> statement-breakpoint
ALTER TABLE `assignments` ADD `section_id` integer NOT NULL REFERENCES sections(id);