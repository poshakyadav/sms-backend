// src/db/schemas/school/whatsapp-balance.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

/**
 * WHATSAPP BALANCE — singleton row (always id=1) per school Turso DB,
 * tracking the school's current usable WhatsApp message credit balance.
 *
 * This schema is introduced now (during the Razorpay phase) purely so the
 * bundle-purchase webhook handler has a real table to credit. The actual
 * WhatsApp SENDING logic (templates, API calls, delivery webhooks) is
 * built in the next phase — this file only concerns the CREDIT side.
 *
 * `email_balance` and `sms_balance` will be added later following the
 * exact same shape, one table per channel (kept separate rather than a
 * single polymorphic table, since each channel's future fields will
 * diverge — e.g. WhatsApp template approval status has no SMS equivalent).
 */
export const whatsappBalanceSchema = sqliteTable("whatsapp_balance", {
  id: integer("id").primaryKey({ autoIncrement: true }).default(1), // always 1 row
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  totalCreditsEverPurchased: integer("total_credits_ever_purchased")
    .notNull()
    .default(0),
  creditsUsed: integer("credits_used").notNull().default(0),
  creditsRemaining: integer("credits_remaining").notNull().default(0),

  lastPurchaseAt: text("last_purchase_at"),
  lastUpdated: text("last_updated")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type WhatsappBalance = typeof whatsappBalanceSchema.$inferSelect;
export type NewWhatsappBalance = typeof whatsappBalanceSchema.$inferInsert;
