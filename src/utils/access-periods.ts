// src/utils/access-periods.ts
//
// Shared helper consumed by BOTH payment rails (manual order + autopay charge)
// to insert a new school_access_periods row. Keeping it here ensures the two
// rails never diverge in their stacking / expiry logic.

import { desc, eq, sql } from "drizzle-orm";
import {
  schoolAccessPeriodsSchema,
  platformPaymentsSchema,
} from "../db/schemas/super";
import { AccessPlanTypeValue, PaymentSourceValue } from "../types/razorpay";

/**
 * Inserts a new `school_access_periods` row using rolling-window stacking.
 *
 * Stacking rule (matches what was agreed in design):
 *   newExpiresAt = max(latestExistingExpiresAt, now) + durationDays
 *
 * This means:
 *   - Paying early (before current period ends) extends from the current
 *     expiry rather than from today — no days are wasted.
 *   - Paying late (after expiry) starts a fresh window from now.
 *   - Switching plan types (MONTHLY ↔ YEARLY) stacks on top of existing
 *     access regardless of planType — the school always gets the maximum
 *     remaining days + the new duration.
 *
 * The row is append-only. Existing rows are never modified. This keeps the
 * table as a clean audit trail of every access grant.
 */
export async function grantAccessPeriod(
  db: any,
  params: {
    schoolId: number;
    planType: AccessPlanTypeValue;
    source: PaymentSourceValue;
    platformPaymentId: number | null;
    durationDays: number;
    notes?: string;
  }
): Promise<{ startsAt: string; expiresAt: string }> {
  const now = new Date();

  // Find the school's latest expiresAt across ALL planTypes.
  const latest = await db
    .select({ expiresAt: schoolAccessPeriodsSchema.expiresAt })
    .from(schoolAccessPeriodsSchema)
    .where(eq(schoolAccessPeriodsSchema.schoolId, params.schoolId))
    .orderBy(desc(schoolAccessPeriodsSchema.expiresAt))
    .limit(1)
    .get();

  const baseDate =
    latest && new Date(latest.expiresAt) > now
      ? new Date(latest.expiresAt)
      : now;

  const expiresAt = new Date(baseDate);
  expiresAt.setDate(expiresAt.getDate() + params.durationDays);

  const startsAt = baseDate.toISOString();
  const expiresAtIso = expiresAt.toISOString();

  await db.insert(schoolAccessPeriodsSchema).values({
    schoolId: params.schoolId,
    planType: params.planType,
    source: params.source,
    platformPaymentId: params.platformPaymentId,
    startsAt,
    expiresAt: expiresAtIso,
    notes: params.notes ?? null,
  });

  return { startsAt, expiresAt: expiresAtIso };
}

/**
 * Returns the school's current access status in a single query.
 * Used by the access-control middleware and the billing screen.
 */
export async function getSchoolAccessStatus(
  db: any,
  schoolId: number
): Promise<{
  hasAccess: boolean;
  expiresAt: string | null;
  daysRemaining: number;
}> {
  const now = new Date();

  const latest = await db
    .select({ expiresAt: schoolAccessPeriodsSchema.expiresAt })
    .from(schoolAccessPeriodsSchema)
    .where(eq(schoolAccessPeriodsSchema.schoolId, schoolId))
    .orderBy(desc(schoolAccessPeriodsSchema.expiresAt))
    .limit(1)
    .get();

  if (!latest) {
    return { hasAccess: false, expiresAt: null, daysRemaining: 0 };
  }

  const expiresAt = new Date(latest.expiresAt);
  const hasAccess = expiresAt > now;
  const daysRemaining = hasAccess
    ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    hasAccess,
    expiresAt: latest.expiresAt,
    daysRemaining,
  };
}
