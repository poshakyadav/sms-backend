// src/db/schemas/super/password-reset-tokens.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { superUsersSchema } from "./super-users";

/**
 * Stores short-lived 6-digit OTP codes for super-admin password reset.
 *
 * Security properties:
 *  - OTP is stored as a bcrypt hash (never plaintext)
 *  - Expires after 10 minutes (expiresAt unix timestamp)
 *  - Single-use: deleted immediately on successful verification
 *  - Rate-limited at service layer (max 3 requests per email per 15 min)
 *  - attemptCount tracked to lock out brute-force (max 5 wrong guesses)
 */
export const passwordResetTokensSchema = sqliteTable("password_reset_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  userId: integer("user_id")
    .references(() => superUsersSchema.id, { onDelete: "cascade" })
    .notNull(),

  // Bcrypt hash of the 6-digit OTP (never store raw OTP)
  otpHash: text("otp_hash").notNull(),

  // Unix timestamp (seconds) — token expires after 10 minutes
  expiresAt: integer("expires_at").notNull(),

  // How many wrong OTP guesses have been made against this token
  attemptCount: integer("attempt_count").notNull().default(0),

  // IP that requested the reset (for audit/rate-limiting)
  requestedFromIp: text("requested_from_ip"),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type PasswordResetToken = typeof passwordResetTokensSchema.$inferSelect;
export type NewPasswordResetToken =
  typeof passwordResetTokensSchema.$inferInsert;
