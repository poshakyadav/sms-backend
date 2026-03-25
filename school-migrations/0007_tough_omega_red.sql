CREATE TABLE `class_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`class_id` integer NOT NULL,
	`section_id` integer NOT NULL,
	`capacity` integer DEFAULT 40 NOT NULL,
	`class_teacher_id` integer,
	`room_number` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_teacher_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_class_section` ON `class_sections` (`school_id`,`class_id`,`section_id`);--> statement-breakpoint
CREATE TABLE `class_section_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`current_class_section_id` integer NOT NULL,
	`next_class_section_id` integer NOT NULL,
	`academic_year_id` integer,
	FOREIGN KEY (`current_class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`next_class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`html_content` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exam_subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`exam_id` integer NOT NULL,
	`class_subject_id` integer NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`room_number` text,
	`max_marks` integer NOT NULL,
	`passing_marks` integer,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `target_idx`;--> statement-breakpoint
ALTER TABLE `notifications` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `notifications` ADD `class_section_id` integer REFERENCES class_sections(id);--> statement-breakpoint
CREATE INDEX `target_idx` ON `notifications` (`target_type`,`class_id`,`class_section_id`);--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `section_id`;--> statement-breakpoint
ALTER TABLE `school_users` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `subjects` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `class_subjects` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `class_subjects` ADD `class_section_id` integer NOT NULL REFERENCES class_sections(id);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_class_section_subject` ON `class_subjects` (`class_section_id`,`subject_id`);--> statement-breakpoint
ALTER TABLE `class_subjects` DROP COLUMN `class_id`;--> statement-breakpoint
ALTER TABLE `students` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `teachers` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `parents` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `staff` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `student_parents` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `class_section_id` integer NOT NULL REFERENCES class_sections(id);--> statement-breakpoint
ALTER TABLE `student_enrollments` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `student_enrollments` DROP COLUMN `class_id`;--> statement-breakpoint
ALTER TABLE `student_enrollments` DROP COLUMN `section_id`;--> statement-breakpoint
ALTER TABLE `fee_structures` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `fee_structures` ADD `class_section_id` integer REFERENCES class_sections(id);--> statement-breakpoint
ALTER TABLE `fee_structures` DROP COLUMN `section_id`;--> statement-breakpoint
ALTER TABLE `teacher_assignments` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `notification_interactions` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `attendances` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `fee_payments` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `exams` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `exams` ADD `class_section_id` integer NOT NULL REFERENCES class_sections(id);--> statement-breakpoint
ALTER TABLE `exams` DROP COLUMN `class_subject_id`;--> statement-breakpoint
ALTER TABLE `exams` DROP COLUMN `date`;--> statement-breakpoint
ALTER TABLE `exams` DROP COLUMN `max_marks`;--> statement-breakpoint
ALTER TABLE `exams` DROP COLUMN `passing_marks`;--> statement-breakpoint
ALTER TABLE `exam_marks` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `exam_marks` ADD `class_subject_id` integer NOT NULL REFERENCES class_subjects(id);--> statement-breakpoint
ALTER TABLE `assignments` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);--> statement-breakpoint
ALTER TABLE `assignments` ADD `class_section_id` integer NOT NULL REFERENCES class_sections(id);--> statement-breakpoint
ALTER TABLE `assignments` DROP COLUMN `section_id`;--> statement-breakpoint
ALTER TABLE `assignment_submissions` ADD `school_id` integer DEFAULT 1 NOT NULL REFERENCES schools(id);