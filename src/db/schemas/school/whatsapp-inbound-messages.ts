// ─────────────────────────────────────────────────────────────────────────────
// 4. WHATSAPP_INBOUND_MESSAGES — log of every message received FROM parents/students
//    Inbound messages are always FREE (no credit deduction).
//    Primarily a read-only audit log; future phases could add auto-reply logic.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const whatsappInboundMessagesSchema = sqliteTable(
  "whatsapp_inbound_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    /** Sender's phone in E.164 WITHOUT + (Meta's format): "919876543210". */
    fromPhone: text("from_phone").notNull(),

    /** Name from Meta's contacts[].profile.name, if available. */
    fromName: text("from_name"),

    /**
     * If the sender's phone matches a school_users.phone, link them.
     * NULL if the number isn't in the school's users table.
     */
    fromUserId: integer("from_user_id").references(() => schoolUsersSchema.id, {
      onDelete: "set null",
    }),

    /** Meta's unique ID for this inbound message. */
    waMessageId: text("wa_message_id").notNull(),

    /** "text" | "image" | "document" | "audio" | "video" | "sticker" | "unknown" */
    messageType: text("message_type").notNull().default("text"),

    /** Message text body, if messageType = "text". */
    textBody: text("text_body"),

    /** Meta media ID, if messageType = "image" | "document" | "audio" | "video". */
    mediaId: text("media_id"),

    /** If this was a reply, the wamid of the message being replied to. */
    replyToWaMessageId: text("reply_to_wa_message_id"),

    /** Unix timestamp from Meta's webhook (string, as Meta sends it). */
    receivedAt: text("received_at").notNull(),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    waMessageIdIdx: index("idx_wa_inbound_wamid").on(table.waMessageId),
    phoneIdx: index("idx_wa_inbound_phone").on(table.fromPhone),
  })
);

export type WhatsappInboundMessage =
  typeof whatsappInboundMessagesSchema.$inferSelect;
export type NewWhatsappInboundMessage =
  typeof whatsappInboundMessagesSchema.$inferInsert;
