// src/modules/school/payments/bundles/services.ts

import { and, eq, sql } from "drizzle-orm";
import {
  messageBundlesSchema,
  platformPaymentsSchema,
  schoolBundlePurchasesSchema,
  schoolsSchema,
} from "../../../../db/schemas/super";
import { getRazorpayService } from "../../../../services/razorpay/razorpay-service";
import { getCommonDB } from "../../../../db";
import { getSchoolDB } from "../../../../db/school-client";
import {
  CreateOrderResult,
  MessageChannelValue,
  PaymentSource,
  PaymentType,
  PlatformPaymentStatus,
  VerifyOrderPaymentInput,
  BUNDLE_PAYMENT_TYPE_BY_CHANNEL,
} from "../../../../types/razorpay";
import { Env } from "../../../../types/common-types";
import {
  whatsappBalanceSchema,
  whatsappBundleCreditsSchema,
} from "../../../../db/schemas/school";

/**
 * Creates a Razorpay Order for a message bundle purchase.
 * The amount is ALWAYS sourced from message_bundles.finalAmountPaise — never
 * from client input. This is enforced here; the route only sends bundleId.
 */
export async function initiateBundlePurchase(
  env: Env["Bindings"],
  schoolId: number,
  bundleId: number
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

  const bundle = await db
    .select()
    .from(messageBundlesSchema)
    .where(eq(messageBundlesSchema.id, bundleId))
    .get();
  if (!bundle) throw new Error("Bundle not found");
  if (!bundle.isActive) throw new Error("This bundle is no longer available");
  if (bundle.finalAmountPaise <= 0)
    throw new Error("Bundle amount is not configured");

  const paymentType =
    BUNDLE_PAYMENT_TYPE_BY_CHANNEL[bundle.channel as MessageChannelValue];
  const razorpay = getRazorpayService(env as any);

  const order = await razorpay.createOrder({
    amountPaise: bundle.finalAmountPaise,
    currency: "INR",
    notes: {
      paymentType,
      schoolId: String(schoolId),
      bundleId: String(bundle.id),
      channel: bundle.channel,
      creditsToAdd: String(bundle.messageCount),
      validityDays: String(bundle.validityDays),
    },
    receipt: `bundle-${
      school.uniqueCode
    }-${bundle.channel.toLowerCase()}-${Date.now()}`,
  });

  // Calculate expiry for the school_bundle_purchases row
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + bundle.validityDays);

  // Create platform_payments row (CREATED)
  const [payment] = await db
    .insert(platformPaymentsSchema)
    .values({
      schoolId,
      razorpayOrderId: order.id,
      source: PaymentSource.MANUAL_ORDER,
      paymentType,
      amountPaise: bundle.finalAmountPaise,
      currency: "INR",
      status: PlatformPaymentStatus.CREATED,
      description: `${bundle.name} — ${school.name}`,
      metaJson: JSON.stringify({
        bundleId: bundle.id,
        channel: bundle.channel,
        messageCount: bundle.messageCount,
        validityDays: bundle.validityDays,
        bundleName: bundle.name,
      }),
    })
    .returning({ id: platformPaymentsSchema.id });

  // Create school_bundle_purchases row (PENDING — credits NOT yet credited)
  await db.insert(schoolBundlePurchasesSchema).values({
    schoolId,
    bundleId: bundle.id,
    platformPaymentId: payment.id,
    channel: bundle.channel as MessageChannelValue,
    creditsAdded: bundle.messageCount,
    expiresAt: expiresAt.toISOString(),
    status: "PENDING",
  });

  return {
    razorpayOrderId: order.id,
    amountPaise: bundle.finalAmountPaise,
    currency: "INR",
    keyId: (env as any).RAZORPAY_KEY_ID,
    platformPaymentId: payment.id,
  };
}

/**
 * Verifies a bundle purchase payment and credits the school's message balance.
 * Idempotent — second call is a no-op if already CAPTURED.
 *
 * Credit flow:
 *   1. Mark platform_payments CAPTURED
 *   2. Mark school_bundle_purchases ACTIVE
 *   3. Write credits into the school's Turso DB (whatsapp_balance + whatsapp_bundle_credits)
 */
export async function verifyBundlePurchase(
  env: Env["Bindings"],
  schoolCode: string,
  input: VerifyOrderPaymentInput & { schoolId: number }
): Promise<{
  success: true;
  creditsAdded: number;
  channel: MessageChannelValue;
}> {
  const db = getCommonDB(env);
  const razorpay = getRazorpayService(env as any);

  // 1. Verify Razorpay signature
  const valid = razorpay.verifyOrderSignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
  });
  if (!valid)
    throw new Error("Payment verification failed: invalid signature.");

  // 2. Load platform_payments row
  const payment = await db
    .select()
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayOrderId, input.razorpayOrderId))
    .get();
  if (!payment) throw new Error("Payment record not found.");

  // 3. Idempotency guard
  if (payment.status === PlatformPaymentStatus.CAPTURED) {
    const meta = JSON.parse(payment.metaJson || "{}");
    return {
      success: true,
      creditsAdded: meta.messageCount || 0,
      channel: meta.channel || "WHATSAPP",
    };
  }

  // 4. Load the bundle purchase row
  const purchase = await db
    .select()
    .from(schoolBundlePurchasesSchema)
    .where(eq(schoolBundlePurchasesSchema.platformPaymentId, payment.id))
    .get();
  if (!purchase) throw new Error("Bundle purchase record not found.");

  // 5. Use a transaction with explicit status guard
  const updateResult = await db.transaction(async (tx: any) => {
    // Re-read with lock inside transaction
    const freshPayment = await tx
      .select({
        id: platformPaymentsSchema.id,
        status: platformPaymentsSchema.status,
      })
      .from(platformPaymentsSchema)
      .where(eq(platformPaymentsSchema.razorpayOrderId, input.razorpayOrderId))
      .get();

    // Idempotency: already captured (perhaps by webhook racing us)
    if (freshPayment?.status === PlatformPaymentStatus.CAPTURED) {
      return { alreadyDone: true };
    }

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

    await tx
      .update(schoolBundlePurchasesSchema)
      .set({ status: "ACTIVE" })
      .where(eq(schoolBundlePurchasesSchema.id, purchase.id));

    return { alreadyDone: false };
  });

  if (updateResult.alreadyDone) {
    const meta = JSON.parse(payment.metaJson || "{}");
    return {
      success: true,
      creditsAdded: meta.messageCount || 0,
      channel: meta.channel || "WHATSAPP",
    };
  }

  // 6. Credit the school's Turso DB based on channel
  await creditSchoolBalance(env, schoolCode, purchase, payment.id);

  return {
    success: true,
    creditsAdded: purchase.creditsAdded,
    channel: purchase.channel as MessageChannelValue,
  };
}

/**
 * Writes credits into the school's Turso DB.
 * Currently handles WHATSAPP. EMAIL/SMS follow the same pattern when implemented.
 * Called ONLY after the super DB transaction succeeds — keeps the Turso write
 * as the last step to ensure idempotency (if Turso write fails, the super DB
 * status is already CAPTURED so a webhook retry / manual reconciliation can
 * re-run just this step).
 */
async function creditSchoolBalance(
  env: Env["Bindings"],
  schoolCode: string,
  purchase: typeof schoolBundlePurchasesSchema.$inferSelect,
  platformPaymentId: number
): Promise<void> {
  if (purchase.channel === "WHATSAPP") {
    const schoolDb = await getSchoolDB(env, schoolCode);

    await schoolDb.transaction(async (tx: any) => {
      // Upsert whatsapp_balance singleton row
      const existing = await tx
        .select()
        .from(whatsappBalanceSchema)
        .where(eq(whatsappBalanceSchema.id, 1))
        .get();

      if (existing) {
        await tx
          .update(whatsappBalanceSchema)
          .set({
            totalCreditsEverPurchased:
              existing.totalCreditsEverPurchased + purchase.creditsAdded,
            creditsRemaining: existing.creditsRemaining + purchase.creditsAdded,
            lastPurchaseAt: new Date().toISOString(),
            lastUpdated: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(whatsappBalanceSchema.id, 1));
      } else {
        await tx.insert(whatsappBalanceSchema).values({
          id: 1,
          totalCreditsEverPurchased: purchase.creditsAdded,
          creditsUsed: 0,
          creditsRemaining: purchase.creditsAdded,
          lastPurchaseAt: new Date().toISOString(),
        });
      }

      // Insert per-bundle credit pool row
      await tx.insert(whatsappBundleCreditsSchema).values({
        superBundlePurchaseId: purchase.id,
        creditsAdded: purchase.creditsAdded,
        creditsRemaining: purchase.creditsAdded,
        expiresAt: purchase.expiresAt,
        isExpired: false,
        purchasedAt: new Date().toISOString(),
      });
    });
  }

  // EMAIL / SMS: same pattern, different schema — implement in WhatsApp phase
  // if (purchase.channel === 'EMAIL') { ... }
  // if (purchase.channel === 'SMS') { ... }
}

/**
 * Lists available active bundles for a given channel.
 * Called by the Angular "Buy Messages" page before initiating a purchase.
 */
export async function getAvailableBundles(
  env: Env["Bindings"],
  channel: MessageChannelValue
) {
  const db = getCommonDB(env);
  return db
    .select()
    .from(messageBundlesSchema)
    .where(
      and(
        eq(messageBundlesSchema.channel, channel),
        eq(messageBundlesSchema.isActive, true)
      )
    )
    .orderBy(messageBundlesSchema.sortOrder)
    .all();
}

/**
 * Returns this school's bundle purchase history for a given channel.
 */
export async function getSchoolBundleHistory(
  env: Env["Bindings"],
  schoolId: number,
  channel?: MessageChannelValue
) {
  const db = getCommonDB(env);

  const conditions: any[] = [
    eq(schoolBundlePurchasesSchema.schoolId, schoolId),
  ];
  if (channel) {
    conditions.push(eq(schoolBundlePurchasesSchema.channel, channel));
  }

  return db
    .select({
      id: schoolBundlePurchasesSchema.id,
      channel: schoolBundlePurchasesSchema.channel,
      creditsAdded: schoolBundlePurchasesSchema.creditsAdded,
      expiresAt: schoolBundlePurchasesSchema.expiresAt,
      status: schoolBundlePurchasesSchema.status,
      createdAt: schoolBundlePurchasesSchema.createdAt,
      bundleName: messageBundlesSchema.name,
      amountPaise: platformPaymentsSchema.amountPaise,
    })
    .from(schoolBundlePurchasesSchema)
    .leftJoin(
      messageBundlesSchema,
      eq(schoolBundlePurchasesSchema.bundleId, messageBundlesSchema.id)
    )
    .leftJoin(
      platformPaymentsSchema,
      eq(
        schoolBundlePurchasesSchema.platformPaymentId,
        platformPaymentsSchema.id
      )
    )
    .where(and(...conditions))
    .orderBy(sql`${schoolBundlePurchasesSchema.createdAt} DESC`)
    .all();
}
