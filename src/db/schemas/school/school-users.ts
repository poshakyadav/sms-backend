import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";

export const Gender = {
  MALE: "MALE", // UDISE+ code: 1
  FEMALE: "FEMALE", // UDISE+ code: 2
  TRANSGENDER: "TRANSGENDER", // UDISE+ code: 3
} as const;

export type GenderValue = (typeof Gender)[keyof typeof Gender];

export const schoolUsersSchema = sqliteTable("school_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(),
  /**
   * UNIQUE per school. Lowercase letters + digits only, must start with a
   * letter (enforced in Zod + application-level validation — SQLite has no
   * native regex CHECK support worth relying on here). Auto-generated at
   * creation time if the admin doesn't supply one — see
   * utils/school/username.ts and createSchoolUser().
   */
  username: text("username").notNull().unique(),

  // Email is now OPTIONAL — a user can log in with just username+password.
  // NOTE: SQLite treats every NULL as distinct for UNIQUE purposes, so
  // multiple users with email = NULL is fine; only *actual* duplicate
  // emails are rejected.
  email: text("email").unique(),
  
  passwordHash: text("password_hash").notNull(),

  // ── PRIMARY ROLE (immutable after creation) ────────────────────────────────
  // This is the user's permanent identity in this school.
  // It determines which profile table (students/teachers/parents/staff) owns
  // their extended data. It is set at creation and CANNOT be removed via
  // the role assignment endpoint — only additional roles can be added/removed.
  //
  // Stored as the role NAME (string) for human-readability and resilience
  // against role ID changes. The role record in the `roles` table is the
  // source of truth for permissions; this field is purely for profile routing.
  primaryRole: text("primary_role").notNull().default(""),

  // Token version for instant permission invalidation when owner changes roles
  tokenVersion: integer("token_version").default(0).notNull(),

  phone: text("phone").notNull().default(""), // This is the primary contact phone number for the user. For students, it's usually the parent's phone.
  alternatePhone: text("alternate_phone").default(""), // Optional second phone number (Alternate contact phone)
  dateOfBirth: text("date_of_birth").default(""), // Added: Common DOB for all users
  gender: text("gender")
    .$type<GenderValue>()
    .default("" as GenderValue), // Common gender for all users

  // ── ADDRESS FIELDS ─────────────────────────────────────────────────────────
  addressLineOne: text("address_line_one").default(""), // Address line 1
  addressLineTwo: text("address_line_two").default(""), // Address line 2
  city: text("city").default(""), // City
  postalCode: text("postal_code").default(""), // Postal/ZIP code
  state: text("state").default(""), // State/Province

  // ── COMMON IDENTITY FIELDS (relevant across all user types) ───────────────
  bloodGroup: text("blood_group").default(""), // A+, A-, B+, B-, O+, O-, AB+, AB-
  avatarUrl: text("avatar_url").default(""), // URL to user avatar image

  /**
   * R2 object key for the user's profile photo, e.g.
   * "avatars/<schoolId>/<userId>/<uuid>.webp"
   * NULL/empty when no avatar has been uploaded yet.
   * Stored so the backend can call r2.delete(avatarKey) when the photo is
   * replaced or removed — mirrors school_feed_posts.imageKey.
   */
  avatarKey: text("avatar_key").default(""),

  // ── PARENTAL / GUARDIAN FIELDS ─────────────────────────────────────────────
  // Stored on school_users because:
  //   • Students need them for UDISE+, TC, admit cards, and emergency contact.
  //   • Teachers/Staff need them for HR records (emergency contact).
  //   • Parents filling forms may also have their own guardian recorded.
  // These are nullable — they are only relevant where the school captures them.

  /**
   * Father's full name.
   * UDISE+ mandates this for every student record.
   * Also used in TC generation, admit cards, and parent-facing reports.
   */
  fatherName: text("father_name").default(""),

  /**
   * Mother's full name.
   * UDISE+ explicitly requires the mother's name as a separate field
   * (not just "parent name"). Critical for government data submissions.
   */
  motherName: text("mother_name").default(""),

  /**
   * Guardian's full name.
   * Used when neither parent is the primary caregiver (e.g., grandparent,
   * uncle/aunt, legal guardian). Optional — filled only when applicable.
   */
  guardianName: text("guardian_name").default(""),

  /**
   * Guardian's relationship to the student.
   * e.g., "Grandfather", "Uncle", "Legal Guardian", "Elder Sibling".
   * Only relevant when guardianName is populated.
   */
  guardianRelation: text("guardian_relation").default(""),

  /**
   * ISO timestamp of when this user first accepted the Terms & Conditions
   * and Privacy Policy. NULL = not yet accepted (legacy users or first login
   * pending acceptance). Set once and never overwritten.
   */
  termsAcceptedAt: text("terms_accepted_at"), // ISO timestamp e.g. "2026-04-22T10:30:00.000Z"

  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolUser = typeof schoolUsersSchema.$inferSelect;
export type NewSchoolUser = typeof schoolUsersSchema.$inferInsert;
