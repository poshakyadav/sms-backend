CREATE TABLE `access_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_type` text NOT NULL,
	`name` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`final_amount_paise` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`razorpay_plan_id` text,
	`autopay_enabled` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_access_plan_type` ON `access_plans` (`plan_type`);--> statement-breakpoint
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
	`setup_fee_discount_paise` integer DEFAULT 0 NOT NULL,
	`setup_fee_final_amount_paise` integer DEFAULT 0 NOT NULL,
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
	`owner_terms_accepted_at` text,
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
--> statement-breakpoint
CREATE TABLE `school_registration_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_name` text NOT NULL,
	`school_type` text DEFAULT 'OTHER' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`estimated_students` integer,
	`owner_name` text NOT NULL,
	`owner_email` text NOT NULL,
	`owner_phone` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '',
	`status` text DEFAULT 'PENDING' NOT NULL,
	`internal_notes` text DEFAULT '',
	`reviewed_by` integer,
	`reviewed_at` text,
	`converted_to_invitation_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`reviewed_by`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `school_contact_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`school_code` text NOT NULL,
	`school_name` text DEFAULT '' NOT NULL,
	`owner_user_id` integer NOT NULL,
	`owner_name` text DEFAULT '' NOT NULL,
	`owner_email` text DEFAULT '' NOT NULL,
	`owner_phone` text DEFAULT '',
	`category` text DEFAULT 'OTHER' NOT NULL,
	`subject` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`internal_notes` text DEFAULT '',
	`resolved_by` integer,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `super_users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `platform_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`razorpay_order_id` text,
	`razorpay_subscription_id` text,
	`razorpay_payment_id` text,
	`razorpay_signature` text,
	`source` text NOT NULL,
	`payment_type` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`status` text NOT NULL,
	`method` text,
	`description` text NOT NULL,
	`meta_json` text DEFAULT '{}',
	`webhook_event_id` text,
	`failure_reason` text,
	`captured_at` text,
	`refunded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_platform_payments_school` ON `platform_payments` (`school_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_payments_order` ON `platform_payments` (`razorpay_order_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_payments_subscription` ON `platform_payments` (`razorpay_subscription_id`);--> statement-breakpoint
CREATE INDEX `idx_platform_payments_status` ON `platform_payments` (`status`);--> statement-breakpoint
CREATE TABLE `school_razorpay_customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`razorpay_customer_id` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_school_razorpay_customer_school` ON `school_razorpay_customers` (`school_id`);--> statement-breakpoint
CREATE TABLE `school_autopay_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`access_plan_id` integer NOT NULL,
	`plan_type` text NOT NULL,
	`razorpay_subscription_id` text NOT NULL,
	`razorpay_customer_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`next_charge_at` text,
	`total_count` integer DEFAULT 0 NOT NULL,
	`paid_count` integer DEFAULT 0 NOT NULL,
	`cancelled_at` text,
	`cancel_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`access_plan_id`) REFERENCES `access_plans`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `school_access_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`plan_type` text NOT NULL,
	`source` text NOT NULL,
	`platform_payment_id` integer,
	`starts_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`platform_payment_id`) REFERENCES `platform_payments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_access_periods_school_expiry` ON `school_access_periods` (`school_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `message_bundles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`name` text NOT NULL,
	`message_count` integer NOT NULL,
	`amount_paise` integer NOT NULL,
	`discount_paise` integer DEFAULT 0 NOT NULL,
	`final_amount_paise` integer NOT NULL,
	`validity_days` integer DEFAULT 365 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `school_bundle_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`bundle_id` integer NOT NULL,
	`platform_payment_id` integer,
	`channel` text NOT NULL,
	`credits_added` integer NOT NULL,
	`expires_at` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bundle_id`) REFERENCES `message_bundles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`platform_payment_id`) REFERENCES `platform_payments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bundle_purchases_school_channel` ON `school_bundle_purchases` (`school_id`,`channel`);--> statement-breakpoint
CREATE TABLE `whatsapp_wamid_index` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wa_message_id` text NOT NULL,
	`school_code` text NOT NULL,
	`school_id` integer NOT NULL,
	`sent_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_wamid_index_wamid` ON `whatsapp_wamid_index` (`wa_message_id`);--> statement-breakpoint
CREATE INDEX `idx_wamid_index_school` ON `whatsapp_wamid_index` (`school_id`);--> statement-breakpoint
CREATE INDEX `idx_wamid_index_sent_at` ON `whatsapp_wamid_index` (`sent_at`);