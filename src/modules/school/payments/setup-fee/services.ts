// src/modules/school/payments/setup-fee/services.ts

import { eq, sql } from "drizzle-orm";
import {
  paymentConfigSchema,
  platformPaymentsSchema,
  schoolsSchema as superSchoolsSchema,
  schoolInvitationsSchema,
} from "../../../../db/schemas/super";
import { getRazorpayService } from "../../../../services/razorpay/razorpay-service";
import { getCommonDB } from "../../../../db";
import { getSchoolDB } from "../../../../db/school-client";
import {
  PaymentType,
  PaymentSource,
  PlatformPaymentStatus,
  CreateOrderResult,
  VerifyOrderPaymentInput,
} from "../../../../types/razorpay";
import { Env } from "../../../../types/common-types";

/**
 * Creates a Razorpay Order for the one-time school setup fee.
 * The amount is always sourced server-side from payment_config.setupFeeFinalAmountPaise.
 * Never trusts the client for the amount.
 */
export async function initiateSetupFeePayment(
  env: Env["Bindings"],
  schoolId: number
): Promise<CreateOrderResult> {
  const db = getCommonDB(env);

  // 1. Verify school exists and is in a payable state
  const school = await db
    .select({
      id: superSchoolsSchema.id,
      name: superSchoolsSchema.name,
      uniqueCode: superSchoolsSchema.uniqueCode,
      onboardingStatus: superSchoolsSchema.onboardingStatus,
    })
    .from(superSchoolsSchema)
    .where(eq(superSchoolsSchema.id, schoolId))
    .get();

  if (!school) throw new Error("School not found");

  if (school.onboardingStatus === "ACTIVE") {
    throw new Error("School setup fee has already been paid.");
  }

  const allowedStatuses = ["INVITED", "REGISTERED", "PAYMENT_SUBMITTED"];
  if (!allowedStatuses.includes(school.onboardingStatus)) {
    throw new Error(`School is not in a valid state for setup fee payment.`);
  }

  // 2. Get setup fee config — always use finalAmountPaise from DB
  const config = await db
    .select({
      setupFeeFinalAmountPaise: paymentConfigSchema.setupFeeFinalAmountPaise,
      isFeeEnabled: paymentConfigSchema.isFeeEnabled,
      currency: paymentConfigSchema.currency,
      feeDescription: paymentConfigSchema.feeDescription,
    })
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  if (!config || !config.isFeeEnabled) {
    throw new Error("Setup fee payments are currently disabled.");
  }

  if (config.setupFeeFinalAmountPaise <= 0) {
    throw new Error(
      "Setup fee amount is not configured. Please contact super admin."
    );
  }

  // 3. Get latest invitation for reference
  const invitation = await db
    .select({ id: schoolInvitationsSchema.id })
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.schoolId, schoolId))
    .orderBy(sql`${schoolInvitationsSchema.createdAt} DESC`)
    .limit(1)
    .get();

  // 4. Create Razorpay Order
  const razorpay = getRazorpayService(env as any);

  const order = await razorpay.createOrder({
    amountPaise: config.setupFeeFinalAmountPaise,
    currency: config.currency || "INR",
    notes: {
      paymentType: PaymentType.SCHOOL_SETUP_FEE,
      schoolId: String(schoolId),
      invitationId: String(invitation?.id ?? ""),
    },
    receipt: `setup-${school.uniqueCode}-${Date.now()}`,
  });

  // 5. Create platform_payments row (status=CREATED)
  const [payment] = await db
    .insert(platformPaymentsSchema)
    .values({
      schoolId,
      razorpayOrderId: order.id,
      source: PaymentSource.MANUAL_ORDER,
      paymentType: PaymentType.SCHOOL_SETUP_FEE,
      amountPaise: config.setupFeeFinalAmountPaise,
      currency: config.currency || "INR",
      status: PlatformPaymentStatus.CREATED,
      description: `One-time setup fee — ${school.name}`,
      metaJson: JSON.stringify({
        schoolCode: school.uniqueCode,
        invitationId: invitation?.id,
        feeDescription: config.feeDescription,
      }),
    })
    .returning({ id: platformPaymentsSchema.id });

  return {
    razorpayOrderId: order.id,
    amountPaise: config.setupFeeFinalAmountPaise,
    currency: config.currency || "INR",
    keyId: (env as any).RAZORPAY_KEY_ID,
    platformPaymentId: payment.id,
  };
}

/**
 * Verifies the Razorpay signature returned from Checkout for a setup fee
 * payment. On success, marks the payment as CAPTURED and triggers school
 * activation (same logic as the approvals service but via Razorpay instead
 * of manual admin approval).
 *
 * Idempotent: safe to call twice; second call is a no-op if already CAPTURED.
 */
export async function verifySetupFeePayment(
  env: Env["Bindings"],
  input: VerifyOrderPaymentInput & { schoolId: number }
): Promise<{ success: true; message: string }> {
  const db = getCommonDB(env);
  const razorpay = getRazorpayService(env as any);

  // 1. Verify signature
  const valid = razorpay.verifyOrderSignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });

  if (!valid) {
    throw new Error("Payment verification failed: invalid signature.");
  }

  // 2. Find the platform_payments row
  const payment = await db
    .select()
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayOrderId, input.razorpayOrderId))
    .get();

  if (!payment) {
    throw new Error("Payment record not found.");
  }

  // 3. Idempotency guard — already processed
  if (payment.status === PlatformPaymentStatus.CAPTURED) {
    return { success: true, message: "Payment already processed." };
  }

  // 4. Update payment to CAPTURED
  await db.transaction(async (tx: any) => {
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

    // 5. Update school onboarding status to PAYMENT_SUBMITTED
    // (Full activation still happens via super-admin approvals module
    // OR can be done auto if you want instant activation on Razorpay payment —
    // for now we keep the manual approval flow for the setup fee)
    await tx
      .update(superSchoolsSchema)
      .set({
        onboardingStatus: "PAYMENT_SUBMITTED",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(superSchoolsSchema.id, input.schoolId));
  });

  return {
    success: true,
    message:
      "Setup fee payment received. Our team will activate your account within 24 hours.",
  };
}
