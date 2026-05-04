import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SchoolRole } from "../../../types/school-role";
import { schoolsSchema } from "./schools";

export const schoolUsersSchema = sqliteTable("school_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
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

  // REMOVED: role column → now handled by user_roles junction
  // role: text("role").$type<SchoolRole>().notNull(),   ← deleted

  // Token version for instant permission invalidation when owner changes roles
  tokenVersion: integer("token_version").default(0).notNull(),

  phone: text("phone").notNull().default(""),
  alternatePhone: text("alternate_phone").default(""), // Optional second phone number (Alternate contact phone)
  dateOfBirth: text("date_of_birth").default(""), // Added: Common DOB for all users (moved from students for simplicity)
  gender: text("gender").default(""), // Added: Common gender
  addressLineOne: text("address_line_one").default(""), // Address line 1
  addressLineTwo: text("address_line_two").default(""), // Address line 2
  city: text("city").default(""), // City
  state: text("state").default(""), // State/Province
  postalCode: text("postal_code").default(""), // Postal/ZIP code
  bloodGroup: text("blood_group").default(""), // Added: Optional for all, but relevant for students/staff
  avatarUrl: text("avatar_url").default(""), // URL to user avatar image

  /**
   * ISO timestamp of when this user first accepted the Terms & Conditions
   * and Privacy Policy. NULL = not yet accepted (legacy users or first login
   * pending acceptance). Set once and never overwritten.
   */
  termsAcceptedAt: text("terms_accepted_at"), // ISO timestamp e.g. "2026-04-22T10:30:00.000Z"
  
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SchoolUser = typeof schoolUsersSchema.$inferSelect;
export type NewSchoolUser = typeof schoolUsersSchema.$inferInsert;