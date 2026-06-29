// src/db/schemas/super/whatsapp-wamid-index.ts
//
// SUPER DB lookup table: maps Meta's wamid → schoolCode so the webhook
// handler can find the right school's Turso DB in O(1) instead of scanning
// every active school. One row per outbound message, inserted at send time,
// deleted or kept as a rolling 90-day archive via a background job.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const whatsappWamidIndexSchema = sqliteTable(
  "whatsapp_wamid_index",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    /**
     * Meta's WhatsApp Message ID — format: "wamid.HBgL..."
     * Up to 128 characters. Unique globally per message.
     * This is the lookup key used by the status webhook handler.
     */
    waMessageId: text("wa_message_id").notNull(),

    /**
     * The school whose Turso DB contains the whatsapp_messages row for
     * this wamid. Stored as uniqueCode (e.g. "DPS001") so the webhook
     * handler can call getSchoolDB(env, schoolCode) directly.
     */
    schoolCode: text("school_code").notNull(),

    /**
     * FK to schools.id — used for bulk-deleting index rows when a school
     * is removed, and for join-based analytics queries.
     */
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * ISO timestamp of when the message was sent. Retained so a background
     * job can prune rows older than 90 days (wamid status events never
     * arrive more than ~72 hours after send in practice).
     */
    sentAt: text("sent_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // PRIMARY lookup: webhook handler does WHERE wa_message_id = ?
    wamidIdx: index("idx_wamid_index_wamid").on(table.waMessageId),

    // Secondary: prune job does WHERE school_id = ? or WHERE sent_at < ?
    schoolIdx: index("idx_wamid_index_school").on(table.schoolId),
    sentAtIdx: index("idx_wamid_index_sent_at").on(table.sentAt),
  })
);

export type WhatsappWamidIndex = typeof whatsappWamidIndexSchema.$inferSelect;
export type NewWhatsappWamidIndex =
  typeof whatsappWamidIndexSchema.$inferInsert;
