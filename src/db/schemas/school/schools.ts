// src/db/schemas/school/schools.ts

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolThemeConfigsSchema } from "./school-theme-configs";

export const schoolsSchema = sqliteTable("schools", {
  id: integer("id").primaryKey({ autoIncrement: true }).default(1), // Always 1
  name: text("name").notNull(), // School Names
  shortName: text("short_name").default(""), // ← NEW: max 8 chars, used for branding (header, sidebar)
  uniqueCode: text("unique_code").notNull().unique(), // From central DB
  addressLineOne: text("address_line_one").notNull().default(""), // Street address
  addressLineTwo: text("address_line_two").default(""),
  phone: text("phone").notNull().default(""), // Contact phone number
  alternatePhone: text("alternate_phone").default(""), // Optional second phone number
  email: text("email").notNull().default(""), // School contact email
  website: text("website").default(""), // School website URL
  logoUrl: text("logo_url").default(""), // URL to school logo image
  logoKey: text("logo_key").default(""), // R2 object key for school logo image
  tagline: text("tagline").default(""), // Optional school tagline or motto
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  // === Active Theme Reference (for fast lookup) ===
  // Active theme reference (relation defined in separate file)
  activeThemeId: integer("active_theme_id"),

  /**
   * UDISE Code — 11-digit unique school identifier assigned by MoE.
   * Schools find this on their recognition certificate or udiseplus.gov.in.
   * This is mandatory for any government reporting and APAAR generation.
   */
  udiseCode: text("udise_code"), // 11-digit, e.g. "09100401101"

  /**
   * State the school is in — needed for state-specific student ID systems
   * and for correct UDISE+ data submission format.
   */
  stateCode: text("state_code"), // 2-digit state code per Census of India

  /**
   * WEEKLY OFF DAYS — school-wide recurring non-working days.
   * JSON array of day-of-week integers: 0=Sunday, 1=Monday, ..., 6=Saturday
   * (matches JS Date#getUTCDay()).
   *
   * Applied by the attendance calendar resolver as the LOWEST-priority rule —
   * any explicit HOLIDAY/WORKING_DAY row in attendance_calendar for a specific
   * date still overrides this (e.g. one class-section running makeup classes
   * on a particular Sunday).
   *
   * Stored as JSON text rather than a separate table: this is singleton
   * school-wide config, not per-date exception data, so the "store
   * exceptions only" philosophy used elsewhere in the calendar system
   * doesn't apply here.
   *
   * Default: "[0]" — Sunday off, the most common convention.
   */
  weeklyOffDays: text("weekly_off_days").notNull().default("[0]"),

  /**
   * District UDISE code — 4 digits, part of the UDISE code but stored
   * separately for easy filtering in multi-school dashboards.
   */
  districtCode: text("district_code"),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type School = typeof schoolsSchema.$inferSelect;
export type NewSchool = typeof schoolsSchema.$inferInsert;
