CREATE TABLE `super_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`token_version` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `super_users_email_unique` ON `super_users` (`email`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`module` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_super_permission_slug` ON `permissions` (`slug`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_super_role_name` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	PRIMARY KEY(`role_id`, `permission_id`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` integer NOT NULL,
	`role_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`),
	FOREIGN KEY (`user_id`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_permissions` (
	`user_id` integer NOT NULL,
	`permission_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `permission_id`),
	FOREIGN KEY (`user_id`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_unique` ON `refresh_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `turso_databases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`auth_token` text NOT NULL,
	`schema_version` integer DEFAULT 0 NOT NULL,
	`is_assigned` integer DEFAULT false NOT NULL,
	`last_migration_at` text DEFAULT CURRENT_TIMESTAMP,
	`created_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turso_databases_url_unique` ON `turso_databases` (`url`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`unique_code` text NOT NULL,
	`email` text NOT NULL,
	`address_line_one` text DEFAULT '' NOT NULL,
	`address_line_two` text DEFAULT '',
	`phone` text DEFAULT '' NOT NULL,
	`alternate_phone` text DEFAULT '',
	`turso_db_id` integer,
	`logo_url` text,
	`onboarding_status` text DEFAULT 'INVITED' NOT NULL,
	`activated_at` text,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`turso_db_id`) REFERENCES `turso_databases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_unique_code_unique` ON `schools` (`unique_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `schools_email_unique` ON `schools` (`email`);--> statement-breakpoint
CREATE TABLE `payment_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upi_id` text DEFAULT '' NOT NULL,
	`qr_code_url` text DEFAULT '',
	`setup_fee_amount` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`fee_description` text DEFAULT 'One-time school setup fee — includes onboarding support by our team' NOT NULL,
	`is_fee_enabled` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `school_invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invite_token` text NOT NULL,
	`school_name` text NOT NULL,
	`school_email` text NOT NULL,
	`school_phone` text DEFAULT '',
	`city` text DEFAULT '',
	`notes` text DEFAULT '',
	`status` text DEFAULT 'PENDING' NOT NULL,
	`invited_by` integer,
	`expires_at` text NOT NULL,
	`registered_at` text,
	`school_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_invite_token` ON `school_invitations` (`invite_token`);--> statement-breakpoint
CREATE TABLE `school_payment_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`invitation_id` integer NOT NULL,
	`amount_expected` integer NOT NULL,
	`amount_paid` integer,
	`utr_number` text,
	`screenshot_url` text,
	`payer_name` text,
	`payer_phone` text,
	`submitted_at` text,
	`status` text DEFAULT 'SUBMITTED' NOT NULL,
	`verified_by` integer,
	`verified_at` text,
	`rejection_reason` text,
	`internal_notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitation_id`) REFERENCES `school_invitations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verified_by`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`otp_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`requested_from_ip` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE cascade
);
