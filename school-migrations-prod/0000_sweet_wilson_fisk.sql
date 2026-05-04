CREATE TABLE `school_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`token_version` integer DEFAULT 0 NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`alternate_phone` text DEFAULT '',
	`date_of_birth` text DEFAULT '',
	`gender` text DEFAULT '',
	`address_line_one` text DEFAULT '',
	`address_line_two` text DEFAULT '',
	`city` text DEFAULT '',
	`state` text DEFAULT '',
	`postal_code` text DEFAULT '',
	`blood_group` text DEFAULT '',
	`avatar_url` text DEFAULT '',
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `school_users_email_unique` ON `school_users` (`email`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`unique_code` text NOT NULL,
	`address_line_one` text DEFAULT '' NOT NULL,
	`address_line_two` text DEFAULT '',
	`phone` text DEFAULT '' NOT NULL,
	`alternate_phone` text DEFAULT '',
	`email` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '',
	`logo_url` text DEFAULT '',
	`tagline` text DEFAULT '',
	`is_active` integer DEFAULT true NOT NULL,
	`active_theme_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_unique_code_unique` ON `schools` (`unique_code`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_unique` ON `refresh_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `school_theme_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`theme_name` text NOT NULL,
	`config` text NOT NULL,
	`is_custom_theme` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_active_theme_per_school` ON `school_theme_configs` (`school_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`module` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_permission_slug_per_school` ON `permissions` (`school_id`,`slug`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_name_per_school` ON `roles` (`school_id`,`name`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`school_id` integer DEFAULT 1 NOT NULL,
	`role_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	PRIMARY KEY(`role_id`, `permission_id`),
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`school_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer NOT NULL,
	`role_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`),
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_permissions` (
	`school_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `permission_id`),
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `academic_years` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `classes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`level` integer NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_code_unique` ON `subjects` (`code`);--> statement-breakpoint
CREATE TABLE `class_subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`class_section_id` integer NOT NULL,
	`subject_id` integer NOT NULL,
	`is_mandatory` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_class_section_subject` ON `class_subjects` (`class_section_id`,`subject_id`);--> statement-breakpoint
CREATE TABLE `students` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`roll_number` text,
	`admission_date` text,
	`previous_school` text,
	`medical_info` text,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teachers` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`qualification` text,
	`experience_years` integer,
	`joining_date` text,
	`specialization` text,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `parents` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`occupation` text,
	`address` text,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`designation` text NOT NULL,
	`department` text,
	`joining_date` text,
	`salary` integer,
	`shift` text,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `student_parents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`student_id` integer NOT NULL,
	`parent_id` integer NOT NULL,
	`relationship` text NOT NULL,
	`is_primary` integer DEFAULT false,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `parents`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `student_enrollments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` integer NOT NULL,
	`academic_year_id` integer NOT NULL,
	`class_section_id` integer NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`roll_number` text,
	`enrollment_date` text DEFAULT CURRENT_DATE,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `fee_structures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`academic_year_id` integer NOT NULL,
	`class_section_id` integer NOT NULL,
	`fee_type` text NOT NULL,
	`amount` integer NOT NULL,
	`due_date` text,
	`is_mandatory` integer DEFAULT true NOT NULL,
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teacher_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`teacher_id` integer NOT NULL,
	`class_section_subject_id` integer NOT NULL,
	`assigned_date` text DEFAULT CURRENT_DATE NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_subject_id`) REFERENCES `class_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`target_type` text NOT NULL,
	`class_id` integer,
	`class_section_id` integer,
	`student_id` integer,
	`due_date` text,
	`link` text,
	`sender_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sender_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `target_idx` ON `notifications` (`target_type`,`class_id`,`class_section_id`);--> statement-breakpoint
CREATE INDEX `created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_interactions` (
	`notification_id` integer NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`read_at` text,
	`is_archived` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`notification_id`, `user_id`),
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `attendances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`enrollment_id` integer NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'PRESENT' NOT NULL,
	`notes` text,
	`marked_by` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`marked_by`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fee_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`enrollment_id` integer NOT NULL,
	`fee_structure_id` integer NOT NULL,
	`amount_paid` integer NOT NULL,
	`payment_date` text DEFAULT CURRENT_DATE NOT NULL,
	`payment_method` text DEFAULT 'CASH' NOT NULL,
	`receipt_number` text NOT NULL,
	`notes` text,
	`recorded_by` integer NOT NULL,
	`is_void` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fee_structure_id`) REFERENCES `fee_structures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fee_payments_receipt_number_unique` ON `fee_payments` (`receipt_number`);--> statement-breakpoint
CREATE TABLE `exams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`academic_year_id` integer NOT NULL,
	`class_section_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exam_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`exam_id` integer NOT NULL,
	`class_subject_id` integer NOT NULL,
	`enrollment_id` integer NOT NULL,
	`marks_obtained` integer NOT NULL,
	`grade` text,
	`remarks` text,
	`entered_by` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exam_id`) REFERENCES `exams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_subject_id`) REFERENCES `class_subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`teacher_assignment_id` integer NOT NULL,
	`class_section_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`due_date` text,
	`target_date` text,
	`max_marks` integer,
	`is_mandatory` integer DEFAULT true NOT NULL,
	`entered_by` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`teacher_assignment_id`) REFERENCES `teacher_assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assignment_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer DEFAULT 1 NOT NULL,
	`assignment_id` integer NOT NULL,
	`enrollment_id` integer NOT NULL,
	`student_status` text DEFAULT 'PENDING' NOT NULL,
	`teacher_status` text DEFAULT 'NOT_RECEIVED' NOT NULL,
	`received_at` text,
	`marks_obtained` integer,
	`remarks` text,
	`entered_by` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enrollment_id`) REFERENCES `student_enrollments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by`) REFERENCES `school_users`(`id`) ON UPDATE no action ON DELETE no action
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
