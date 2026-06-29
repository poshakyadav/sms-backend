// src/modules/super/access-plans/services.ts

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { accessPlansSchema } from "../../../db/schemas/super";
import { Env } from "../../../types/common-types";
import { AccessPlanTypeValue } from "../../../types/razorpay";
import { getCommonDB } from "../../../db";

/**
 * ACCESS PLANS SERVICE — super-admin management of the two access plan
 * rows (MONTHLY, YEARLY). amountPaise and planType are fixed at seed time
 * and are NOT editable here by design (changing the base price of an
 * existing plan type is a business decision that should go through a new
 * plan type, not a silent edit — keeps historical billing records
 * meaningful). Only discountPaise, autopayEnabled, and isActive are
 * editable.
 */

export async function getAllAccessPlans(env: Env["Bindings"]) {
  const db = getCommonDB(env);
  return db
    .select()
    .from(accessPlansSchema)
    .orderBy(accessPlansSchema.planType)
    .all();
}

export async function getAccessPlanByType(
  env: Env["Bindings"],
  planType: AccessPlanTypeValue
) {
  const db = getCommonDB(env);
  return db
    .select()
    .from(accessPlansSchema)
    .where(eq(accessPlansSchema.planType, planType))
    .get();
}

/**
 * Updates the discount on an access plan and recomputes finalAmountPaise.
 *
 * IMPORTANT: If the discount actually changes, razorpayPlanId is reset to
 * NULL in the same transaction. This is what makes the next Autopay sign-up
 * for this plan type create a fresh Razorpay Plan at the new price (Plans
 * are immutable on Razorpay — see schema comment in access-plans.ts for the
 * full rationale). Existing live Autopay subscriptions are UNAFFECTED and
 * keep being charged at whatever price their already-created Plan has —
 * this is intentional and matches how every real-world recurring-payment
 * system handles price changes on a live mandate.
 */
export async function updateAccessPlanDiscount(
  env: Env["Bindings"],
  planType: AccessPlanTypeValue,
  input: {
    discountPaise?: number;
    autopayEnabled?: boolean;
    isActive?: boolean;
  }
) {
  const db = getCommonDB(env);

  return db.transaction(async (tx: any) => {
    const existing = await tx
      .select()
      .from(accessPlansSchema)
      .where(eq(accessPlansSchema.planType, planType))
      .get();

    if (!existing) {
      throw new Error(
        `Access plan "${planType}" not found. Run the seeder first.`
      );
    }

    const newDiscountPaise = input.discountPaise ?? existing.discountPaise;

    if (newDiscountPaise < 0 || newDiscountPaise > existing.amountPaise) {
      throw new Error(
        "Discount must be between 0 and the plan's sticker amount."
      );
    }

    const discountChanged = newDiscountPaise !== existing.discountPaise;
    const newFinalAmountPaise = existing.amountPaise - newDiscountPaise;

    await tx
      .update(accessPlansSchema)
      .set({
        discountPaise: newDiscountPaise,
        finalAmountPaise: newFinalAmountPaise,
        ...(input.autopayEnabled !== undefined && {
          autopayEnabled: input.autopayEnabled,
        }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        // Discount changed → force a fresh Plan on next Autopay sign-up.
        // Existing live subscriptions keep their already-created Plan and
        // are unaffected.
        ...(discountChanged && { razorpayPlanId: null }),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(accessPlansSchema.planType, planType));

    return tx
      .select()
      .from(accessPlansSchema)
      .where(eq(accessPlansSchema.planType, planType))
      .get();
  });
}

/**
 * Seeds the two access plan rows if they don't already exist. Safe to call
 * on every boot — no-ops if rows are already present. Call this from your
 * existing setup/seeder flow (alongside seedSuperPermissionsAndRoles).
 */
export async function seedAccessPlans(env: Env["Bindings"]) {
  const db = getCommonDB(env);

  const existing = await db.select().from(accessPlansSchema).all();
  if (existing.length > 0) return existing;

  const rows = [
    {
      planType: "MONTHLY" as const,
      name: "Monthly Access",
      amountPaise: 59900, // ₹599.00
      discountPaise: 0,
      finalAmountPaise: 59900,
      durationDays: 30,
      autopayEnabled: true,
      isActive: true,
    },
    {
      planType: "YEARLY" as const,
      name: "Yearly Access",
      amountPaise: 898500, // ₹8985.00
      discountPaise: 0,
      finalAmountPaise: 898500,
      durationDays: 365,
      autopayEnabled: true,
      isActive: true,
    },
  ];

  await db.insert(accessPlansSchema).values(rows);
  return db.select().from(accessPlansSchema).all();
}
