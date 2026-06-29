// ─────────────────────────────────────────────────────────────────────────
// src/db/schemas/school/whatsapp-bundle-credits.ts
// ─────────────────────────────────────────────────────────────────────────

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { sql } from "drizzle-orm";

/**
 * WHATSAPP BUNDLE CREDITS — one row per bundle purchase, tracked separately
 * from the aggregate `whatsapp_balance` so that EXPIRY can be enforced
 * per-purchase (a bundle bought 13 months ago should expire even if the
 * school bought another bundle last week). Deduction order (FIFO by
 * expiry) and the actual "send a message, decrement a credit" logic is
 * WhatsApp-phase work — this schema only stores the pool.
 */
export const whatsappBundleCreditsSchema = sqliteTable(
  "whatsapp_bundle_credits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    /** FK (logical, cross-database) to super DB's school_bundle_purchases.id. */
    superBundlePurchaseId: integer("super_bundle_purchase_id").notNull(),

    creditsAdded: integer("credits_added").notNull(),
    creditsRemaining: integer("credits_remaining").notNull(),

    expiresAt: text("expires_at").notNull(),
    isExpired: integer("is_expired", { mode: "boolean" })
      .notNull()
      .default(false),

    purchasedAt: text("purchased_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type WhatsappBundleCredit =
  typeof whatsappBundleCreditsSchema.$inferSelect;
export type NewWhatsappBundleCredit =
  typeof whatsappBundleCreditsSchema.$inferInsert;
