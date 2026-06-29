// src/db/schemas/super/school-autopay-subscriptions.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { accessPlansSchema } from "./access-plans";
import {
  AccessPlanTypeValue,
  AutopaySubscriptionStatusValue,
} from "../../../types/razorpay";

/**
 * SCHOOL AUTOPAY SUBSCRIPTIONS — Razorpay Subscription lifecycle tracking.
 *
 * ── CRITICAL: THIS TABLE IS INFORMATIONAL / MANAGEMENT-ONLY ───────────────
 * It exists purely so the school's billing screen can show "Auto-renew is
 * ON, next charge ₹599 on 5 July" and let them cancel it, and so the super
 * admin can see which schools are on Autopay vs paying manually.
 *
 * It is NEVER read by the access-control middleware (requireActiveAccess).
 * Access is determined SOLELY by `school_access_periods.expiresAt`. If a
 * school's mandate gets `halted` after failed retries, nothing here needs
 * special handling — their access simply lapses naturally on its existing
 * expiry date, exactly as if they had forgotten to pay manually. This is
 * what keeps the two payment rails from duplicating access-control logic.
 *
 * One school can have at most one ACTIVE row per planType in practice
 * (enforced in the service layer, not the DB, since a school could
 * theoretically cancel and re-subscribe, leaving historical rows behind —
 * which we want to keep for audit/history).
 */
export const schoolAutopaySubscriptionsSchema = sqliteTable(
  "school_autopay_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    accessPlanId: integer("access_plan_id")
      .references(() => accessPlansSchema.id, { onDelete: "restrict" })
      .notNull(),

    /** Denormalised copy of access_plans.planType for fast filtering. */
    planType: text("plan_type").$type<AccessPlanTypeValue>().notNull(),

    /** Razorpay Subscription ID, e.g. "sub_xxxxxxxxxxxxx" */
    razorpaySubscriptionId: text("razorpay_subscription_id").notNull(),

    /** Razorpay Customer ID this subscription is linked to. */
    razorpayCustomerId: text("razorpay_customer_id").notNull(),

    /**
     * Mirrors Razorpay's subscription status verbatim:
     * created | authenticated | active | pending | halted | cancelled |
     * completed | paused | expired
     */
    status: text("status").$type<AutopaySubscriptionStatusValue>().notNull(),

    /** Informational mirror of Razorpay's current billing cycle window. */
    currentPeriodStart: text("current_period_start"),
    currentPeriodEnd: text("current_period_end"),

    /** Unix timestamp (as text) of the next scheduled charge, from Razorpay. */
    nextChargeAt: text("next_charge_at"),

    /** Total billing cycles configured (0 = indefinite until cancelled). */
    totalCount: integer("total_count").notNull().default(0),

    /** How many cycles have been successfully charged so far. */
    paidCount: integer("paid_count").notNull().default(0),

    cancelledAt: text("cancelled_at"),
    cancelReason: text("cancel_reason"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type SchoolAutopaySubscription =
  typeof schoolAutopaySubscriptionsSchema.$inferSelect;
export type NewSchoolAutopaySubscription =
  typeof schoolAutopaySubscriptionsSchema.$inferInsert;
