// ─────────────────────────────────────────────────────────────────────────────
// 3. WHATSAPP_BULK_SENDS — groups individual messages into one send operation
//    School admin can track the progress of a mass notification
//    (e.g. "Fee Reminder — June 2026 → sent 142/150, failed 8")
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";
import { BulkSendStatusValue, BulkTargetTypeValue, WhatsappTemplateCategoryValue } from "../../../types/whatsapp";

export const whatsappBulkSendsSchema = sqliteTable("whatsapp_bulk_sends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  /** Admin-facing label, e.g. "Fee Reminder — June 2026". */
  title: text("title").notNull(),

  /** Template name used for all messages in this bulk. */
  templateName: text("template_name").notNull(),

  /** "UTILITY" | "MARKETING" | "AUTHENTICATION" */
  templateCategory: text("template_category")
    .$type<WhatsappTemplateCategoryValue>()
    .notNull(),

  /**
   * Who was targeted:
   * ALL_PARENTS, ALL_STUDENTS, ALL_STAFF, CLASS_SECTION_PARENTS,
   * CLASS_SECTION_STUDENTS, CUSTOM_USER_LIST, CUSTOM_PHONE_LIST
   */
  targetType: text("target_type").$type<BulkTargetTypeValue>().notNull(),

  /**
   * JSON blob describing the target.
   * For CLASS_SECTION_*: { classSectionId: 12 }
   * For CUSTOM_USER_LIST: { userIds: [1,2,3,...] }
   * For CUSTOM_PHONE_LIST: { phones: ["9198765...","9187654..."] }
   * For ALL_*: {} (empty, all-school query used)
   */
  targetJson: text("target_json").notNull().default("{}"),

  /** Total recipients resolved at initiation time. */
  totalRecipients: integer("total_recipients").notNull().default(0),

  /** Running count of successfully-sent messages (updated as sends complete). */
  sentCount: integer("sent_count").notNull().default(0),

  /** Running count of delivered messages (updated by webhooks). */
  deliveredCount: integer("delivered_count").notNull().default(0),

  /** Running count of permanently-failed messages. */
  failedCount: integer("failed_count").notNull().default(0),

  /** Total credits deducted for this bulk (= totalRecipients at initiation). */
  creditsDeducted: integer("credits_deducted").notNull().default(0),

  /** "DRAFT" | "SENDING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" */
  status: text("status")
    .$type<BulkSendStatusValue>()
    .notNull()
    .default("DRAFT"),

  createdBy: integer("created_by").references(() => schoolUsersSchema.id, {
    onDelete: "set null",
  }),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  completedAt: text("completed_at"),
});

export type WhatsappBulkSend = typeof whatsappBulkSendsSchema.$inferSelect;
export type NewWhatsappBulkSend = typeof whatsappBulkSendsSchema.$inferInsert;
