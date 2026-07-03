// src/modules/super/access-plans/services.ts

import { eq, inArray, sql } from "drizzle-orm";
import {
  accessPlansSchema,
  schoolAutopaySubscriptionsSchema,
} from "../../../db/schemas/super";
import { Env } from "../../../types/common-types";
import { AccessPlanTypeValue, AutopaySubscriptionStatus, AutopaySubscriptionStatusValue } from "../../../types/razorpay";
import { getCommonDB } from "../../../db";

// Typed as AutopaySubscriptionStatusValue[] (not string[]) so it matches
// schoolAutopaySubscriptionsSchema.status's column type for inArray().
const ACTIVE_SUBSCRIPTION_STATUSES: AutopaySubscriptionStatusValue[] = [
  AutopaySubscriptionStatus.ACTIVE,
  AutopaySubscriptionStatus.AUTHENTICATED,
  AutopaySubscriptionStatus.CREATED,
];

/** Attaches a live count of active/authenticated/created Autopay subs per planType. */
async function withActiveAutopayCounts(db: any, plans: any[]) {
  if (plans.length === 0) return plans;

  const counts = await db
    .select({
      planType: schoolAutopaySubscriptionsSchema.planType,
      count: sql<number>`count(*)`,
    })
    .from(schoolAutopaySubscriptionsSchema)
    .where(inArray(schoolAutopaySubscriptionsSchema.status, ACTIVE_SUBSCRIPTION_STATUSES))
    .groupBy(schoolAutopaySubscriptionsSchema.planType)
    .all();

  const countMap = new Map(counts.map((c: any) => [c.planType, Number(c.count)]));

  return plans.map((p) => ({
    ...p,
    activeAutopaySubscriptions: countMap.get(p.planType) ?? 0,
  }));
}

export async function getAllAccessPlans(env: Env["Bindings"]) {
  const db = getCommonDB(env);
  const plans = await db
    .select()
    .from(accessPlansSchema)
    .orderBy(accessPlansSchema.planType)
    .all();
  return withActiveAutopayCounts(db, plans);
}

export async function getAccessPlanByType(
  env: Env["Bindings"],
  planType: AccessPlanTypeValue
) {
  const db = getCommonDB(env);
  const plan = await db
    .select()
    .from(accessPlansSchema)
    .where(eq(accessPlansSchema.planType, planType))
    .get();
  if (!plan) return null;
  const [withCount] = await withActiveAutopayCounts(db, [plan]);
  return withCount;
}

/**
 * Updates an access plan's pricing/config. `planType` and `durationDays`
 * stay fixed by design — they're baked into PaymentType.ACCESS_MONTHLY/
 * YEARLY routing in the webhook handler and into the Razorpay Plan
 * "period" (monthly/yearly). Editing them isn't a pricing tweak, it's a
 * data-model change — do that as a migration, not through this endpoint.
 *
 * If amountPaise or discountPaise actually changes, razorpayPlanId is
 * reset to NULL so the next Autopay sign-up lazily creates a fresh
 * (immutable) Razorpay Plan at the new price. Existing live Autopay
 * subscriptions are unaffected — the caller gets `priceChanged` plus
 * `activeAutopaySubscriptions` so the UI can warn the admin.
 */
export async function updateAccessPlan(
  env: Env["Bindings"],
  planType: AccessPlanTypeValue,
  input: {
    name?: string;
    amountPaise?: number;
    discountPaise?: number;
    autopayEnabled?: boolean;
    isActive?: boolean;
  }
): Promise<{ plan: any; priceChanged: boolean }> {
  const db = getCommonDB(env);

  const priceChanged = await db.transaction(async (tx: any) => {
    const existing = await tx
      .select()
      .from(accessPlansSchema)
      .where(eq(accessPlansSchema.planType, planType))
      .get();

    if (!existing) {
      throw new Error(`Access plan "${planType}" not found. Run the seeder first.`);
    }

    const newAmountPaise = input.amountPaise ?? existing.amountPaise;
    const newDiscountPaise = input.discountPaise ?? existing.discountPaise;

    if (newAmountPaise <= 0) {
      throw new Error("Sticker amount must be greater than zero.");
    }
    if (newDiscountPaise < 0 || newDiscountPaise > newAmountPaise) {
      throw new Error("Discount must be between 0 and the plan's sticker amount.");
    }

    const changed =
      newAmountPaise !== existing.amountPaise || newDiscountPaise !== existing.discountPaise;
    const newFinalAmountPaise = newAmountPaise - newDiscountPaise;

    await tx
      .update(accessPlansSchema)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        amountPaise: newAmountPaise,
        discountPaise: newDiscountPaise,
        finalAmountPaise: newFinalAmountPaise,
        ...(input.autopayEnabled !== undefined && { autopayEnabled: input.autopayEnabled }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(changed && { razorpayPlanId: null }),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(accessPlansSchema.planType, planType));

    return changed;
  });

  const updated = await getAccessPlanByType(env, planType);
  return { plan: updated, priceChanged };
}

/** Idempotent — no-ops if rows already exist. Unchanged from your version. */
export async function seedAccessPlans(env: Env["Bindings"]) {
  const db = getCommonDB(env);
  const existing = await db.select().from(accessPlansSchema).all();
  if (existing.length > 0) return existing;

  await db.insert(accessPlansSchema).values([
    {
      planType: "MONTHLY" as const,
      name: "Monthly Access",
      amountPaise: 59900,
      discountPaise: 0,
      finalAmountPaise: 59900,
      durationDays: 30,
      autopayEnabled: true,
      isActive: true,
    },
    {
      planType: "YEARLY" as const,
      name: "Yearly Access",
      amountPaise: 898500,
      discountPaise: 0,
      finalAmountPaise: 898500,
      durationDays: 365,
      autopayEnabled: true,
      isActive: true,
    },
  ]);

  return db.select().from(accessPlansSchema).all();
}