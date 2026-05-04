// src/db/schemas/school/schools.ts

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolThemeConfigsSchema } from "./school-theme-configs";

export const schoolsSchema = sqliteTable("schools", {
  id: integer("id").primaryKey({ autoIncrement: true }).default(1), // Always 1
  name: text("name").notNull(),  // School Names
  shortName: text("short_name").default(""),  // ← NEW: max 8 chars, used for branding (header, sidebar)
  uniqueCode: text("unique_code").notNull().unique(), // From central DB 
  addressLineOne: text("address_line_one").notNull().default(""), // Street address
  addressLineTwo: text("address_line_two").default(""), 
  phone: text("phone").notNull().default(""), // Contact phone number
  alternatePhone: text("alternate_phone").default(""), // Optional second phone number
  email: text("email").notNull().default(""), // School contact email
  website: text("website").default(""), // School website URL
  logoUrl: text("logo_url").default(""), // URL to school logo image
  tagline: text("tagline").default(""), // Optional school tagline or motto
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  // === Active Theme Reference (for fast lookup) ===
  // Active theme reference (relation defined in separate file)
  activeThemeId: integer("active_theme_id"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type School = typeof schoolsSchema.$inferSelect;
export type NewSchool = typeof schoolsSchema.$inferInsert;