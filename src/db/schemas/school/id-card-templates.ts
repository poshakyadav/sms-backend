// src/db/schemas/school/id-card-templates.ts

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

// ─────────────────────────────────────────────────────────────────────────────
// ID CARD HOLDER TYPE
//
// Distinct from the exam-related `card_templates` table (admit/report cards).
// ID cards are rendered entirely CLIENT-SIDE in Angular — this table stores
// LAYOUT CONFIGURATION (which fields to show, colors, font choices, photo
// placement), not HTML strings. The Angular component interprets this JSON
// to render the live card + QR + PDF export. This avoids any HTML-injection
// surface and keeps the backend a pure data API.
// ─────────────────────────────────────────────────────────────────────────────

export const IdCardHolderType = {
  STUDENT: "STUDENT",
  STAFF: "STAFF", // covers TEACHER, and any non-student/non-parent school_users role
} as const;

export type IdCardHolderTypeValue =
  (typeof IdCardHolderType)[keyof typeof IdCardHolderType];

export const ALL_ID_CARD_HOLDER_TYPES = [
  IdCardHolderType.STUDENT,
  IdCardHolderType.STAFF,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONFIG SHAPE (stored as JSON in `layoutConfig`)
//
// Kept as a documented TS type here for reference by the service layer /
// frontend, even though Drizzle stores it as a raw JSON string column.
// This is intentionally a flat, simple config — not a full visual page
// builder — so v1 ships fast and is easy to render predictably at fixed
// CR80 (3.375in x 2.125in) dimensions on the frontend.
// ─────────────────────────────────────────────────────────────────────────────

export interface IdCardLayoutConfig {
  /** Hex color for the card's primary accent band/header (e.g. "#4f46e5") */
  accentColor: string;
  /** Hex color for text on the accent band (e.g. "#ffffff") */
  accentTextColor: string;
  /** Hex color for the card body background (usually "#ffffff") */
  backgroundColor: string;

  /** Show the school logo in the header */
  showLogo: boolean;
  /** Show the school tagline under the school name */
  showTagline: boolean;

  /** Which holder fields to render, in display order. Field keys are
   *  resolved by the frontend against the card-data payload — see the
   *  IdCardData shape returned by GET /school/id-cards/:id. */
  visibleFields: string[];
  // STUDENT example: ["className","sectionName","rollNumber","admissionNumber","bloodGroup"]
  // STAFF example:   ["designation","department","employeeCode","bloodGroup"]

  /** Small print line at the bottom of the card, e.g.
   *  "If found, please return to <school name>, <phone>" */
  footerNote: string;

  /** QR code size as a fraction of the card width (0–1), default ~0.22 */
  qrSizeRatio: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

export const idCardTemplatesSchema = sqliteTable(
  "id_card_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    name: text("name").notNull(), // e.g. "Default Student Card", "Staff — Navy"

    holderType: text("holder_type").$type<IdCardHolderTypeValue>().notNull(),

    // JSON-encoded IdCardLayoutConfig (see interface above)
    layoutConfig: text("layout_config").notNull(),

    // Only one default template per (school, holderType) — enforced in
    // service layer on write (unset previous default before setting new one),
    // mirroring the pattern already used for school_theme_configs' active flag.
    isDefault: integer("is_default", { mode: "boolean" })
      .default(false)
      .notNull(),

    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Template names must be unique per school + holder type (avoid confusing
    // duplicates in the template picker dropdown)
    uniqueNamePerSchoolAndType: uniqueIndex(
      "uq_id_card_template_name_per_type"
    ).on(table.schoolId, table.holderType, table.name),
  })
);

export type IdCardTemplate = typeof idCardTemplatesSchema.$inferSelect;
export type NewIdCardTemplate = typeof idCardTemplatesSchema.$inferInsert;
