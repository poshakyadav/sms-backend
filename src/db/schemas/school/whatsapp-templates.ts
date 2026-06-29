import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { WhatsappTemplateCategoryValue } from "../../../types/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
//  WHATSAPP_TEMPLATES — local cache of our Meta-approved templates
//    Synced via POST /school/whatsapp/templates/sync
//    One row per template name (platform-level; same templates apply to all schools).
// ─────────────────────────────────────────────────────────────────────────────

export const whatsappTemplatesSchema = sqliteTable(
  "whatsapp_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    /** Template name exactly as registered in Meta WABA (e.g. "sms_fee_reminder"). */
    name: text("name").notNull(),

    /** "en" | "hi" | "en_US" etc. */
    language: text("language").notNull().default("en"),

    /** "UTILITY" | "MARKETING" | "AUTHENTICATION" */
    category: text("category").$type<WhatsappTemplateCategoryValue>().notNull(),

    /**
     * Meta's status for this template.
     * APPROVED — can be sent; PAUSED — Meta paused it due to quality issues;
     * REJECTED — cannot be sent; PENDING — still under review.
     */
    status: text("status").notNull().default("PENDING"),

    /** Full body text with {{1}} {{2}} placeholders, for display/preview. */
    bodyPreview: text("body_preview").notNull().default(""),

    /**
     * JSON array of variable names in order, e.g.
     * ["parent_name","student_name","date","class_section","status","school_name"]
     * Used by the UI to show which fields need to be filled.
     */
    variableNames: text("variable_names").notNull().default("[]"),

    /** ISO timestamp of last sync from Meta. */
    lastSyncedAt: text("last_synced_at"),
    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    uniqueName: index("idx_wa_template_name").on(table.name, table.language),
  })
);

export type WhatsappTemplate = typeof whatsappTemplatesSchema.$inferSelect;
export type NewWhatsappTemplate = typeof whatsappTemplatesSchema.$inferInsert;
