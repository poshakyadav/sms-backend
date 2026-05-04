ALTER TABLE `student_enrollments` ADD `unenrollment_type` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `unenrollment_reason` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `unenrolled_at` text;--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `unenrolled_by` integer REFERENCES school_users(id);