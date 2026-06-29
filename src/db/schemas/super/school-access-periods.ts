// src/db/schemas/super/school-access-periods.ts

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import {
  AccessPlanTypeValue,
  PaymentSourceValue,
} from "../../../types/razorpay";
import { platformPaymentsSchema } from "./platform-payments";

/**
 * SCHOOL ACCESS PERIODS — THE single source of truth for portal access.
 *
 * ── THIS IS THE ONLY TABLE THE ACCESS-CONTROL MIDDLEWARE READS ────────────
 * Every other Razorpay-related table (platform_payments, access_plans,
 * school_autopay_subscriptions, school_razorpay_customers) exists to
 * support PURCHASING access. This table is the result of a purchase, and
 * it alone determines whether a school can currently use the software.
 *
 * The rule is exactly what you specified: ROLLING window from payment date,
 * STACKING on top of existing access. Concretely, on every successful
 * payment (manual order OR autopay charge) for an access plan:
 *
 *     newExpiresAt = max(currentLatestExpiresAt, now) + durationDays
 *
 * Worked example matching your spec exactly:
 *   - School has no prior access. Pays for MONTHLY on 5 June.
 *     → new row: startsAt = 5 June, expiresAt = 5 July.
 *   - On 30 June, school is still within their paid window (good).
 *   - If they do NOT pay again, on 5 July 00:00 access lapses — the
 *     `requireActiveAccess` middleware starts rejecting requests because
 *     `now() > expiresAt` for every row belonging to this school.
 *   - If they pay again on 5 July (or any day before/after), the new
 *     period starts from max(oldExpiresAt, now), so paying early never
 *     wastes days, and paying late simply starts the new 30-day window
 *     from the moment of payment (no makeup days for the gap — this is
 *     the simplest, least surprising rule and matches "pay to use,
 *     don't pay and lose access" exactly).
 *
 * Switching between MONTHLY and YEARLY: the stacking rule is intentionally
 * type-agnostic — `max(currentLatestExpiresAt, now)` is computed across ALL
 * of the school's periods regardless of planType, so a school can buy a
 * YEARLY period on top of remaining MONTHLY days (or vice versa) and the
 * two simply concatenate on the timeline. The `planType` column on each row
 * is purely a historical/billing record of what was purchased — the
 * effective access check only ever cares about the MAX expiresAt across
 * all of a school's rows.
 *
 * One row is inserted per successful payment — rows are NEVER updated or
 * merged. This keeps the table a clean, append-only audit trail of every
 * access grant, which doubles as your renewal history for support/billing
 * screens.
 */
export const schoolAccessPeriodsSchema = sqliteTable(
  "school_access_periods",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    /** What was purchased — "MONTHLY" | "YEARLY". Historical record only. */
    planType: text("plan_type").$type<AccessPlanTypeValue>().notNull(),

    /** Which rail funded this period — "MANUAL_ORDER" | "AUTOPAY_CHARGE". */
    source: text("source").$type<PaymentSourceValue>().notNull(),

    /**
     * FK to the platform_payments row that paid for this period. Nullable
     * only to tolerate the rare super-admin manual override grant (see
     * school-access.override permission) — every normal payment-driven
     * row always has this set.
     */
    platformPaymentId: integer("platform_payment_id").references(
      () => platformPaymentsSchema.id,
      { onDelete: "set null" }
    ),

    /** ISO timestamp — when this specific period began (payment moment, or
     *  the previous period's expiry if stacking on top of existing access). */
    startsAt: text("starts_at").notNull(),

    /**
     * ISO timestamp — when this specific period ends. THE field that
     * access-control reads. A school has access IFF at least one row has
     * expiresAt > now().
     */
    expiresAt: text("expires_at").notNull(),

    /**
     * Free-text note for manual overrides (e.g. "Goodwill 7-day extension —
     * payment gateway outage, approved by <super admin name>"). NULL for
     * normal payment-driven rows.
     */
    notes: text("notes"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Every access check filters by schoolId and orders/compares by
    // expiresAt — this composite index makes "does this school have
    // access right now" a fast index-only lookup.
    schoolExpiryIdx: index("idx_access_periods_school_expiry").on(
      table.schoolId,
      table.expiresAt
    ),
  })
);

export type SchoolAccessPeriod = typeof schoolAccessPeriodsSchema.$inferSelect;
export type NewSchoolAccessPeriod =
  typeof schoolAccessPeriodsSchema.$inferInsert;
