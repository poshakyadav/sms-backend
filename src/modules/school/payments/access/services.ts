// src/modules/school/payments/access/services.ts

import { eq, sql } from "drizzle-orm";
import {
  accessPlansSchema,
  platformPaymentsSchema,
  schoolAccessPeriodsSchema,
  schoolAutopaySubscriptionsSchema,
  schoolRazorpayCustomersSchema,
  schoolsSchema,
} from "../../../../db/schemas/super";
import { getRazorpayService } from "../../../../services/razorpay/razorpay-service";
import { getCommonDB } from "../../../../db";
import { getSchoolDB } from "../../../../db/school-client";
import {
  AccessPlanTypeValue,
  AutopaySubscriptionStatus,
  CreateAutopaySubscriptionResult,
  CreateOrderResult,
  PaymentSource,
  PaymentType,
  PlatformPaymentStatus,
  VerifyOrderPaymentInput,
  VerifySubscriptionPaymentInput,
} from "../../../../types/razorpay";
import { grantAccessPeriod } from "../../../../utils/access-periods";
import { Env } from "../../../../types/common-types";

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL ORDER RAIL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Razorpay Order for a manual (non-autopay) access plan purchase.
 * Used for both MONTHLY and YEARLY. The school pays now; access is granted
 * on successful verification.
 */
export async function initiateAccessOrder(
  env: Env["Bindings"],
  schoolId: number,
  planType: AccessPlanTypeValue
): Promise<CreateOrderResult> {
  const db = getCommonDB(env);

  const school = await db
    .select({
      id: schoolsSchema.id,
      name: schoolsSchema.name,
      uniqueCode: schoolsSchema.uniqueCode,
    })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, schoolId))
    .get();
  if (!school) throw new Error("School not found");

  const plan = await db
    .select()
    .from(accessPlansSchema)
    .where(eq(accessPlansSchema.planType, planType))
    .get();
  if (!plan) throw new Error(`Access plan "${planType}" not found`);
  if (!plan.isActive)
    throw new Error(`The ${planType} plan is not currently available`);
  if (plan.finalAmountPaise <= 0)
    throw new Error("Plan amount is not configured");

  const razorpay = getRazorpayService(env as any);
  const paymentType =
    planType === "MONTHLY"
      ? PaymentType.ACCESS_MONTHLY
      : PaymentType.ACCESS_YEARLY;

  const order = await razorpay.createOrder({
    amountPaise: plan.finalAmountPaise,
    currency: "INR",
    notes: {
      paymentType,
      schoolId: String(schoolId),
      accessPlanId: String(plan.id),
      planType,
      durationDays: String(plan.durationDays),
    },
    receipt: `access-${
      school.uniqueCode
    }-${planType.toLowerCase()}-${Date.now()}`,
  });

  const [payment] = await db
    .insert(platformPaymentsSchema)
    .values({
      schoolId,
      razorpayOrderId: order.id,
      source: PaymentSource.MANUAL_ORDER,
      paymentType,
      amountPaise: plan.finalAmountPaise,
      currency: "INR",
      status: PlatformPaymentStatus.CREATED,
      description: `${plan.name} — ${school.name}`,
      metaJson: JSON.stringify({
        planType,
        durationDays: plan.durationDays,
        planId: plan.id,
      }),
    })
    .returning({ id: platformPaymentsSchema.id });

  return {
    razorpayOrderId: order.id,
    amountPaise: plan.finalAmountPaise,
    currency: "INR",
    keyId: (env as any).RAZORPAY_KEY_ID,
    platformPaymentId: payment.id,
  };
}

/**
 * Verifies the Razorpay signature after a manual access-plan order.
 * On success, inserts a new school_access_periods row to grant portal access.
 * Idempotent: second call is a no-op if the row is already CAPTURED.
 */
export async function verifyAccessOrder(
  env: Env["Bindings"],
  input: VerifyOrderPaymentInput & { schoolId: number }
): Promise<{ success: true; expiresAt: string; daysRemaining: number }> {
  const db = getCommonDB(env);
  const razorpay = getRazorpayService(env as any);

  const valid = razorpay.verifyOrderSignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!valid)
    throw new Error("Payment verification failed: invalid signature.");

  const payment = await db
    .select()
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayOrderId, input.razorpayOrderId))
    .get();
  if (!payment) throw new Error("Payment record not found.");

  if (payment.status === PlatformPaymentStatus.CAPTURED) {
    // Already processed — return current access status
    const period = await db
      .select({ expiresAt: schoolAccessPeriodsSchema.expiresAt })
      .from(schoolAccessPeriodsSchema)
      .where(eq(schoolAccessPeriodsSchema.platformPaymentId, payment.id))
      .get();
    const expiresAt = period?.expiresAt ?? "";
    const daysRemaining = expiresAt
      ? Math.max(
          0,
          Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000)
        )
      : 0;
    return { success: true, expiresAt, daysRemaining };
  }

  // Parse durationDays from metaJson
  let durationDays = 30;
  let planType: AccessPlanTypeValue = "MONTHLY";
  try {
    const meta = JSON.parse(payment.metaJson || "{}");
    durationDays = meta.durationDays || 30;
    planType = meta.planType || "MONTHLY";
  } catch {}

  return await db.transaction(async (tx: any) => {
    await tx
      .update(platformPaymentsSchema)
      .set({
        status: PlatformPaymentStatus.CAPTURED,
        razorpayPaymentId: input.razorpayPaymentId,
        razorpaySignature: input.razorpaySignature,
        capturedAt: new Date().toISOString(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(platformPaymentsSchema.id, payment.id));

    const { expiresAt } = await grantAccessPeriod(tx, {
      schoolId: input.schoolId,
      planType,
      source: PaymentSource.MANUAL_ORDER,
      platformPaymentId: payment.id,
      durationDays,
    });

    // Ensure school.isActive = true
    await tx
      .update(schoolsSchema)
      .set({ isActive: true, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schoolsSchema.id, input.schoolId));

    const daysRemaining = Math.ceil(
      (new Date(expiresAt).getTime() - Date.now()) / 86400000
    );
    return { success: true as const, expiresAt, daysRemaining };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOPAY (UPI AUTOPAY / RAZORPAY SUBSCRIPTIONS) RAIL
// ─────────────────────────────────────────────────────────────────────────────

/** Ensures a Razorpay Customer exists for this school; creates one if not. */
async function ensureRazorpayCustomer(
  db: any,
  env: Env["Bindings"],
  school: { id: number; name: string; email: string; phone?: string | null }
): Promise<string> {
  const existing = await db
    .select({
      razorpayCustomerId: schoolRazorpayCustomersSchema.razorpayCustomerId,
    })
    .from(schoolRazorpayCustomersSchema)
    .where(eq(schoolRazorpayCustomersSchema.schoolId, school.id))
    .get();

  if (existing) return existing.razorpayCustomerId;

  const razorpay = getRazorpayService(env as any);
  const customer = await razorpay.createCustomer({
    name: school.name,
    email: school.email,
    contact: school.phone || "",
  });

  await db.insert(schoolRazorpayCustomersSchema).values({
    schoolId: school.id,
    razorpayCustomerId: customer.id,
    email: school.email,
    phone: school.phone || "",
  });

  return customer.id;
}

/** Lazily creates the Razorpay Plan for a given access plan if it doesn't exist yet. */
async function ensureRazorpayPlan(
  db: any,
  env: Env["Bindings"],
  plan: typeof accessPlansSchema.$inferSelect
): Promise<string> {
  if (plan.razorpayPlanId) return plan.razorpayPlanId;

  const razorpay = getRazorpayService(env as any);
  const rzPlan = await razorpay.createPlan({
    period: plan.planType === "MONTHLY" ? "monthly" : "yearly",
    interval: 1,
    amountPaise: plan.finalAmountPaise,
    name: plan.name,
    description: `${plan.name} — school portal access`,
  });

  await db
    .update(accessPlansSchema)
    .set({ razorpayPlanId: rzPlan.id, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(accessPlansSchema.id, plan.id));

  return rzPlan.id;
}

/**
 * Initiates a UPI Autopay subscription for the given school and plan type.
 * This requires the school to opt in explicitly — it is never the default flow.
 *
 * After calling this, the Angular frontend opens Razorpay Checkout with the
 * returned subscriptionId. The school authorises the mandate once; subsequent
 * charges happen automatically and trigger the subscription.charged webhook.
 */
export async function initiateAutopaySubscription(
  env: Env["Bindings"],
  schoolId: number,
  planType: AccessPlanTypeValue
): Promise<CreateAutopaySubscriptionResult> {
  const db = getCommonDB(env);

  const school = await db
    .select({
      id: schoolsSchema.id,
      name: schoolsSchema.name,
      email: schoolsSchema.email,
      phone: schoolsSchema.phone,
      uniqueCode: schoolsSchema.uniqueCode,
    })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, schoolId))
    .get();
  if (!school) throw new Error("School not found");

  const plan = await db
    .select()
    .from(accessPlansSchema)
    .where(eq(accessPlansSchema.planType, planType))
    .get();
  if (!plan) throw new Error(`Plan "${planType}" not found`);
  if (!plan.isActive) throw new Error(`The ${planType} plan is not available`);
  if (!plan.autopayEnabled) {
    throw new Error(
      "UPI Autopay is not currently enabled for this plan. Please use the manual payment option."
    );
  }

  // Guard: only one active autopay sub per plan per school
  const existingActiveSub = await db
    .select({ id: schoolAutopaySubscriptionsSchema.id })
    .from(schoolAutopaySubscriptionsSchema)
    .where(eq(schoolAutopaySubscriptionsSchema.schoolId, schoolId))
    .get();

  if (existingActiveSub) {
    // Check if actually active
    const sub = await db
      .select({ status: schoolAutopaySubscriptionsSchema.status })
      .from(schoolAutopaySubscriptionsSchema)
      .where(eq(schoolAutopaySubscriptionsSchema.id, existingActiveSub.id))
      .get();
    if (sub && ["active", "authenticated", "created"].includes(sub.status)) {
      throw new Error(
        "You already have an active auto-renewal subscription. Cancel it before creating a new one."
      );
    }
  }

  const razorpay = getRazorpayService(env as any);
  const paymentType =
    planType === "MONTHLY"
      ? PaymentType.ACCESS_MONTHLY
      : PaymentType.ACCESS_YEARLY;

  // Lazy-create customer and plan
  const customerId = await ensureRazorpayCustomer(db, env, {
    id: school.id,
    name: school.name,
    email: school.email || "",
    phone: school.phone,
  });
  const razorpayPlanId = await ensureRazorpayPlan(db, env, plan);

  // 120 cycles ≈ 10 years monthly; effectively "indefinite" until cancelled
  const totalCount = planType === "MONTHLY" ? 120 : 10;

  const subscription = await razorpay.createSubscription({
    planId: razorpayPlanId,
    customerId,
    totalCount,
    notes: {
      paymentType,
      schoolId: String(schoolId),
      accessPlanId: String(plan.id),
      planType,
      durationDays: String(plan.durationDays),
      rail: "AUTOPAY_CHARGE",
    },
  });

  // Persist subscription record (status=created until webhook arrives)
  await db.insert(schoolAutopaySubscriptionsSchema).values({
    schoolId,
    accessPlanId: plan.id,
    planType,
    razorpaySubscriptionId: subscription.id,
    razorpayCustomerId: customerId,
    status: AutopaySubscriptionStatus.CREATED,
    totalCount,
    paidCount: 0,
  });

  return {
    razorpaySubscriptionId: subscription.id,
    keyId: (env as any).RAZORPAY_KEY_ID,
    amountPaise: plan.finalAmountPaise,
    currency: "INR",
  };
}

/**
 * Verifies the Razorpay signature from the subscription authorisation
 * transaction (the one-time UPI mandate setup). After this, Razorpay will
 * auto-charge at each cycle; the subscription.charged webhook handles
 * granting access for each subsequent cycle.
 */
export async function verifyAutopaySubscriptionAuth(
  env: Env["Bindings"],
  input: VerifySubscriptionPaymentInput & { schoolId: number }
): Promise<{ success: true; message: string }> {
  const db = getCommonDB(env);
  const razorpay = getRazorpayService(env as any);

  const valid = razorpay.verifySubscriptionSignature({
    razorpaySubscriptionId: input.razorpaySubscriptionId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!valid)
    throw new Error("Subscription authorisation verification failed.");

  // Update local subscription record to authenticated
  await db
    .update(schoolAutopaySubscriptionsSchema)
    .set({
      status: AutopaySubscriptionStatus.AUTHENTICATED,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      eq(
        schoolAutopaySubscriptionsSchema.razorpaySubscriptionId,
        input.razorpaySubscriptionId
      )
    );

  return {
    success: true,
    message:
      "Auto-renewal enabled. Your subscription will automatically renew each cycle.",
  };
}

/**
 * Cancels a school's active Autopay subscription.
 * cancelAtCycleEnd=true lets the current paid period finish before cancelling.
 */
export async function cancelAutopaySubscription(
  env: Env["Bindings"],
  schoolId: number,
  cancelAtCycleEnd: boolean = true
): Promise<{ success: true; message: string }> {
  const db = getCommonDB(env);

  const sub = await db
    .select()
    .from(schoolAutopaySubscriptionsSchema)
    .where(eq(schoolAutopaySubscriptionsSchema.schoolId, schoolId))
    .orderBy(sql`${schoolAutopaySubscriptionsSchema.createdAt} DESC`)
    .limit(1)
    .get();

  if (!sub) throw new Error("No active subscription found.");
  if (["cancelled", "completed", "expired"].includes(sub.status)) {
    throw new Error("Subscription is already cancelled or expired.");
  }

  const razorpay = getRazorpayService(env as any);
  await razorpay.cancelSubscription(
    sub.razorpaySubscriptionId,
    cancelAtCycleEnd
  );

  await db
    .update(schoolAutopaySubscriptionsSchema)
    .set({
      status: AutopaySubscriptionStatus.CANCELLED,
      cancelledAt: new Date().toISOString(),
      cancelReason: cancelAtCycleEnd
        ? "Cancelled by school (end of cycle)"
        : "Cancelled immediately by school",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolAutopaySubscriptionsSchema.id, sub.id));

  return {
    success: true,
    message: cancelAtCycleEnd
      ? "Auto-renewal cancelled. You will retain access until your current period ends."
      : "Auto-renewal cancelled immediately.",
  };
}

/**
 * Returns the school's current access + autopay status for the billing screen.
 */
export async function getAccessStatus(env: Env["Bindings"], schoolId: number) {
  const db = getCommonDB(env);
  const { getSchoolAccessStatus } = await import(
    "../../../../utils/access-periods"
  );

  const [accessStatus, autopay] = await Promise.all([
    getSchoolAccessStatus(db, schoolId),
    db
      .select({
        id: schoolAutopaySubscriptionsSchema.id,
        planType: schoolAutopaySubscriptionsSchema.planType,
        status: schoolAutopaySubscriptionsSchema.status,
        nextChargeAt: schoolAutopaySubscriptionsSchema.nextChargeAt,
        paidCount: schoolAutopaySubscriptionsSchema.paidCount,
      })
      .from(schoolAutopaySubscriptionsSchema)
      .where(eq(schoolAutopaySubscriptionsSchema.schoolId, schoolId))
      .orderBy(sql`${schoolAutopaySubscriptionsSchema.createdAt} DESC`)
      .limit(1)
      .get(),
  ]);

  return { ...accessStatus, autopay: autopay ?? null };
}
