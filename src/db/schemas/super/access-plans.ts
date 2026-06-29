// src/db/schemas/super/access-plans.ts

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { AccessPlanTypeValue } from "../../../types/razorpay";

/**
 * ACCESS PLANS — exactly two rows exist in this table, ever: MONTHLY and
 * YEARLY. This table replaces the original design doc's "subscription_plans"
 * concept entirely. There is no notion of Basic/Standard/Premium tiers —
 * every school that pays gets the exact same software, just billed either
 * monthly (₹599) or yearly (₹8985).
 *
 * ── THE THREE-FIELD DISCOUNT PATTERN ──────────────────────────────────────
 * amountPaise        → sticker price shown crossed-out on the pricing page
 * discountPaise       → flat discount the super admin can apply at any time
 * finalAmountPaise     → amountPaise - discountPaise, RECOMPUTED + persisted
 *                        on every update. This is the only value that is
 *                        ever sent to Razorpay as `amount` when creating an
 *                        Order, or as a Plan's `item.amount` when creating
 *                        an Autopay Plan.
 *
 * ── WHY THIS IS SAFE EVEN THOUGH RAZORPAY PLANS ARE IMMUTABLE ─────────────
 * A Razorpay Plan, once created, can never be edited (see razorpay docs:
 * "Once a Plan is created, you cannot edit or delete it"). This is normally
 * a problem for discount-driven pricing — but in this system it's a
 * non-issue for 95% of purchases:
 *
 *   - The MANUAL_ORDER rail (the default, used by setup fee, bundles, and
 *     most access-plan purchases) never touches a Razorpay Plan at all. It
 *     creates a fresh Order with `amount: finalAmountPaise` every single
 *     time. Changing the discount takes effect on the very next purchase,
 *     instantly, with zero Razorpay-side side effects.
 *
 *   - The AUTOPAY_CHARGE rail (opt-in only) DOES need a Razorpay Plan,
 *     because Subscriptions require one. We create it LAZILY — the first
 *     time any school opts into Autopay for a given planType — using
 *     whatever finalAmountPaise is at that moment, and cache the resulting
 *     `razorpayPlanId` here so we don't create duplicate Plans for every
 *     Autopay sign-up.
 *
 *     If the super admin later changes the discount, the service layer
 *     clears razorpayPlanId back to NULL in the same transaction (see
 *     super/access-plans/services.ts → updateAccessPlanDiscount). The next
 *     school that opts into Autopay for that plan type causes a fresh Plan
 *     to be created at the new price. Schools already on an existing
 *     Autopay mandate keep being charged at the OLD plan's price until they
 *     cancel and re-subscribe — this is the correct, expected behaviour for
 *     any live recurring-payment relationship (you don't silently change
 *     the price on an active mandate), and it only affects the small
 *     minority of schools who opted into Autopay in the first place.
 */
export const accessPlansSchema = sqliteTable(
  "access_plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    /** "MONTHLY" | "YEARLY" — unique, exactly one row per type. */
    planType: text("plan_type").$type<AccessPlanTypeValue>().notNull(),

    /** Human-readable label for pricing page, e.g. "Monthly Access". */
    name: text("name").notNull(),

    /** Sticker price in paise, e.g. 59900 = ₹599.00 */
    amountPaise: integer("amount_paise").notNull(),

    /** Flat discount in paise, editable by super admin. Default 0. */
    discountPaise: integer("discount_paise").notNull().default(0),

    /**
     * Computed & persisted: amountPaise - discountPaise. The only amount
     * ever sent to Razorpay. Never trust a client-submitted value for this —
     * always recompute server-side on write.
     */
    finalAmountPaise: integer("final_amount_paise").notNull(),

    /**
     * Rolling window length added to a school's access on successful
     * payment. 30 for MONTHLY, 365 for YEARLY. Kept configurable (not
     * hard-coded) in case pricing/terms are tuned later without a schema
     * change — e.g. switching to a 31-day month grace period.
     */
    durationDays: integer("duration_days").notNull(),

    /**
     * Razorpay Plan ID (`plan_xxxxx`), created LAZILY only when the first
     * school opts into Autopay for this plan type. NULL until then, and
     * reset to NULL whenever discountPaise changes (see service layer).
     * The MANUAL_ORDER rail never reads or writes this field.
     */
    razorpayPlanId: text("razorpay_plan_id"),

    /**
     * Platform-wide kill switch for Autopay on this plan type. When false,
     * the "auto-renew with UPI Autopay" option is hidden from the frontend
     * and the autopay/initiate endpoint rejects with a clear error — the
     * manual-order rail keeps working regardless of this flag.
     */
    autopayEnabled: integer("autopay_enabled", { mode: "boolean" })
      .notNull()
      .default(true),

    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    uniquePlanType: uniqueIndex("uq_access_plan_type").on(table.planType),
  })
);

export type AccessPlan = typeof accessPlansSchema.$inferSelect;
export type NewAccessPlan = typeof accessPlansSchema.$inferInsert;
