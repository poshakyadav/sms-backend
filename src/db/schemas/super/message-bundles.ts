// src/db/schemas/super/message-bundles.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { MessageChannelValue } from "../../../types/razorpay";

/**
 * MESSAGE BUNDLES — platform-defined catalog of purchasable message credit
 * packs, for any channel. Today only WHATSAPP rows exist; EMAIL and SMS
 * rows will be added later with zero schema changes — just new rows with a
 * different `channel` value, exactly as the original design doc intended.
 *
 * Same three-field discount pattern as access_plans and payment_config:
 *   amountPaise → finalAmountPaise = amountPaise - discountPaise
 *
 * Unlike access_plans, bundles are pure Orders-rail purchases — there is no
 * Autopay equivalent for a one-off bundle buy, so there's no Razorpay Plan
 * concept here at all. Every purchase creates a fresh Order with
 * `amount: finalAmountPaise` at the moment of purchase. Changing the
 * discount on a bundle takes effect immediately for the next purchase,
 * with no Razorpay-side caveats whatsoever.
 */
export const messageBundlesSchema = sqliteTable("message_bundles", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  /** "WHATSAPP" | "EMAIL" | "SMS" */
  channel: text("channel").$type<MessageChannelValue>().notNull(),

  /** e.g. "WhatsApp Starter 500" */
  name: text("name").notNull(),

  /** Number of messages this bundle grants. */
  messageCount: integer("message_count").notNull(),

  /** Sticker price in paise. */
  amountPaise: integer("amount_paise").notNull(),

  /** Flat discount in paise, editable by super admin. Default 0. */
  discountPaise: integer("discount_paise").notNull().default(0),

  /** Computed & persisted: amountPaise - discountPaise. Sent to Razorpay. */
  finalAmountPaise: integer("final_amount_paise").notNull(),

  /** How many days after purchase the credits remain usable before expiry. */
  validityDays: integer("validity_days").notNull().default(365),

  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

  /** Display ordering on the "Buy Messages" page, ascending. */
  sortOrder: integer("sort_order").notNull().default(0),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type MessageBundle = typeof messageBundlesSchema.$inferSelect;
export type NewMessageBundle = typeof messageBundlesSchema.$inferInsert;
