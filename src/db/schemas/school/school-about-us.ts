// src/db/schemas/school/school-about-us.ts
// ─────────────────────────────────────────────────────────────────────────────
// School About Us — singleton per school (one row, always id=1 schoolId)
// All array/object fields are stored as JSON text columns.
// Only users with settings.manage permission can write; all authenticated
// school users can read.
// ─────────────────────────────────────────────────────────────────────────────

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const schoolAboutUsSchema = sqliteTable("school_about_us", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  // ── Mission / Vision / Intro ──────────────────────────────────────────────
  description: text("description").default("").notNull(),   // hero subtitle
  mission: text("mission").default("").notNull(),
  vision: text("vision").default("").notNull(),

  // ── History & Founding ────────────────────────────────────────────────────
  foundedYear: integer("founded_year"),               // e.g. 1998
  foundedBy: text("founded_by").default(""),          // e.g. "Late Shri Ram Prasad"
  history: text("history").default(""),               // long-form narrative

  // ── Affiliation & Accreditation ───────────────────────────────────────────
  affiliationBoard: text("affiliation_board").default(""),   // "CBSE" | "ICSE" | …
  affiliationNumber: text("affiliation_number").default(""), // official reg. number
  accreditation: text("accreditation").default(""),          // e.g. "NAAC A+"

  // ── Key Statistics ────────────────────────────────────────────────────────
  totalStudents: integer("total_students"),
  totalTeachers: integer("total_teachers"),
  totalStaff: integer("total_staff"),
  campusAreaAcres: text("campus_area_acres").default(""),    // e.g. "12.5"

  // ── Principal / Head of School ────────────────────────────────────────────
  principalName: text("principal_name").default(""),
  principalMessage: text("principal_message").default(""),
  principalAvatarUrl: text("principal_avatar_url").default(""),

  // ── Social Media ──────────────────────────────────────────────────────────
  facebookUrl: text("facebook_url").default(""),
  twitterUrl: text("twitter_url").default(""),
  instagramUrl: text("instagram_url").default(""),
  youtubeUrl: text("youtube_url").default(""),
  linkedinUrl: text("linkedin_url").default(""),

  // ── JSON array columns ────────────────────────────────────────────────────
  // facilities  → string[]
  // galleryUrls → string[]
  // coreValues  → { title: string; description: string }[]
  // achievements → { year?: number; title: string; description: string }[]
  facilities: text("facilities").default("[]").notNull(),
  galleryUrls: text("gallery_urls").default("[]").notNull(),
  coreValues: text("core_values").default("[]").notNull(),
  achievements: text("achievements").default("[]").notNull(),

  // ── Timestamps ────────────────────────────────────────────────────────────
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SchoolAboutUs = typeof schoolAboutUsSchema.$inferSelect;
export type NewSchoolAboutUs = typeof schoolAboutUsSchema.$inferInsert;