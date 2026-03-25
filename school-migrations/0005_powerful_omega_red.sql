ALTER TABLE `assignments` ADD `target_date` text;--> statement-breakpoint
ALTER TABLE `assignment_submissions` ADD `student_status` text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE `assignment_submissions` ADD `teacher_status` text DEFAULT 'NOT_RECEIVED' NOT NULL;--> statement-breakpoint
ALTER TABLE `assignment_submissions` ADD `received_at` text;--> statement-breakpoint
ALTER TABLE `assignment_submissions` DROP COLUMN `status`;--> statement-breakpoint
ALTER TABLE `assignment_submissions` DROP COLUMN `submission_date`;