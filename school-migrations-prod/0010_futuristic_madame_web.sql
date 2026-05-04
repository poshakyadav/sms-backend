ALTER TABLE `exams` ADD `status` text DEFAULT 'SCHEDULED' NOT NULL;--> statement-breakpoint
ALTER TABLE `exams` ADD `admit_card_published` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `exams` ADD `report_card_published` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `exams` ADD `admit_card_published_at` text;--> statement-breakpoint
ALTER TABLE `exams` ADD `report_card_published_at` text;--> statement-breakpoint
ALTER TABLE `exam_subjects` ADD `subject_label` text;