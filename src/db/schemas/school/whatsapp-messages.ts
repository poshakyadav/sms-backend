import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";
import { sql } from "drizzle-orm";
import { WhatsappMessageStatusValue, WhatsappRecipientTypeValue, WhatsappTemplateCategoryValue } from "../../../types/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
//  WHATSAPP_MESSAGES — every outbound message attempt
//    One row per recipient per send. This is the primary ledger for:
//      - Credit deduction tracking (1 credit per row)
//      - Delivery status tracking (updated by webhook events)
//      - Send history visible to school admin
// ─────────────────────────────────────────────────────────────────────────────

export const whatsappMessagesSchema = sqliteTable(
  "whatsapp_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    /**
     * FK to school_users.id — the recipient if they are a school user.
     * NULL for external phone numbers not linked to any user.
     */
    recipientUserId: integer("recipient_user_id").references(
      () => schoolUsersSchema.id,
      { onDelete: "set null" }
    ),

    /** E.164 format WITHOUT the + prefix (Meta's convention): "919876543210". */
    recipientPhone: text("recipient_phone").notNull(),

    /** Display name for the billing/history screen. */
    recipientName: text("recipient_name").notNull().default(""),

    /** "PARENT" | "STUDENT" | "STAFF" | "EXTERNAL" */
    recipientType: text("recipient_type")
      .$type<WhatsappRecipientTypeValue>()
      .notNull(),

    /** Template name used (e.g. "sms_attendance_marked"). */
    templateName: text("template_name").notNull(),

    /** "en" | "hi" etc. */
    templateLanguage: text("template_language").notNull().default("en"),

    /** "UTILITY" | "MARKETING" | "AUTHENTICATION" */
    templateCategory: text("template_category")
      .$type<WhatsappTemplateCategoryValue>()
      .notNull(),

    /**
     * JSON object of variable name → value pairs used in this specific send,
     * e.g. {"parent_name":"Mr. Sharma","student_name":"Rohan","status":"Present",...}
     * Stored for audit/re-send capability.
     */
    variablesJson: text("variables_json").notNull().default("{}"),

    /**
     * Meta's WhatsApp Message ID (wamid) — set once Meta accepts the request.
     * Format: "wamid.HBgL..." — up to 128 characters.
     * Used to match incoming status webhooks back to this row.
     */
    waMessageId: text("wa_message_id"),

    /**
     * QUEUED → SENT → DELIVERED → READ
     *      ↘ FAILED / TEMPLATE_ERROR
     *
     * QUEUED: credit deducted, not yet sent to Meta
     * SENT:   Meta accepted (wamid assigned); single tick
     * DELIVERED: Meta delivered to device; double tick
     * READ:   recipient opened; blue tick
     * FAILED: permanent failure (invalid number, blocked, etc.)
     * TEMPLATE_ERROR: template not approved at send time
     */
    status: text("status")
      .$type<WhatsappMessageStatusValue>()
      .notNull()
      .default("QUEUED"),

    /** Meta error code if status=FAILED (e.g. 131047, 131006). */
    failureCode: text("failure_code"),

    /** Human-readable failure description. */
    failureMessage: text("failure_message"),

    /**
     * Always 1 — every message costs 1 credit regardless of template type.
     * Stored explicitly so credit deduction history is self-documenting.
     */
    creditsUsed: integer("credits_used").notNull().default(1),

    /**
     * FK to whatsapp_bulk_sends.id — populated when this message was sent
     * as part of a bulk operation. NULL for individually-triggered sends
     * (e.g. automatic attendance notification).
     */
    bulkSendId: integer("bulk_send_id"),

    /**
     * Which module triggered this send, for analytics.
     * e.g. "attendance" | "fees" | "exams" | "assignments" | "manual"
     */
    triggeredByModule: text("triggered_by_module"),

    /** Entity ID within the triggering module (e.g. school_fee_payments.id). */
    triggeredByEntityId: integer("triggered_by_entity_id"),

    // Status timestamps — populated by webhook updates
    sentAt: text("sent_at"),
    deliveredAt: text("delivered_at"),
    readAt: text("read_at"),
    failedAt: text("failed_at"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Webhook handler looks up rows by wamid — must be fast
    waMessageIdIdx: index("idx_wa_messages_wamid").on(table.waMessageId),
    // Admin history screen filters by status and time
    statusIdx: index("idx_wa_messages_status").on(
      table.status,
      table.createdAt
    ),
    // Bulk send progress queries filter by bulkSendId
    bulkSendIdx: index("idx_wa_messages_bulk").on(table.bulkSendId),
    // Module-triggered queries (e.g. "all messages for this fee payment")
    moduleIdx: index("idx_wa_messages_module").on(
      table.triggeredByModule,
      table.triggeredByEntityId
    ),
  })
);

export type WhatsappMessage = typeof whatsappMessagesSchema.$inferSelect;
export type NewWhatsappMessage = typeof whatsappMessagesSchema.$inferInsert;
