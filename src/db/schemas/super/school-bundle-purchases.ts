// src/db/schemas/super/school-bundle-purchases.ts

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { messageBundlesSchema } from "./message-bundles";
import { platformPaymentsSchema } from "./platform-payments";
import {
  BundlePurchaseStatusValue,
  MessageChannelValue,
} from "../../../types/razorpay";

/**
 * SCHOOL BUNDLE PURCHASES — every time a school buys a message bundle, one
 * row is written here in the SUPER DB (this is the cross-school audit/
 * billing record). The actual usable credit balance lives in the school's
 * own Turso DB (`whatsapp_balance` / `whatsapp_bundle_credits`), which is
 * built in the WhatsApp integration phase, not this Razorpay phase.
 *
 * Flow: PENDING (order created) → ACTIVE (payment captured, credits pushed
 * to school's Turso DB) → EXPIRED (validityDays elapsed) or REFUNDED.
 */
export const schoolBundlePurchasesSchema = sqliteTable(
  "school_bundle_purchases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    bundleId: integer("bundle_id")
      .references(() => messageBundlesSchema.id, { onDelete: "restrict" })
      .notNull(),

    platformPaymentId: integer("platform_payment_id").references(
      () => platformPaymentsSchema.id,
      { onDelete: "set null" }
    ),

    /** Denormalised from message_bundles.channel for fast filtering. */
    channel: text("channel").$type<MessageChannelValue>().notNull(),

    /** Snapshot of message_bundles.messageCount at time of purchase. */
    creditsAdded: integer("credits_added").notNull(),

    /** purchasedAt + bundle's validityDays, snapshotted at purchase time. */
    expiresAt: text("expires_at").notNull(),

    /** "PENDING" | "ACTIVE" | "EXPIRED" | "REFUNDED" */
    status: text("status").$type<BundlePurchaseStatusValue>().notNull(),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    schoolChannelIdx: index("idx_bundle_purchases_school_channel").on(
      table.schoolId,
      table.channel
    ),
  })
);

export type SchoolBundlePurchase =
  typeof schoolBundlePurchasesSchema.$inferSelect;
export type NewSchoolBundlePurchase =
  typeof schoolBundlePurchasesSchema.$inferInsert;
