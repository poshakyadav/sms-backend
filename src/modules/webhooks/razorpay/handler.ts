// src/modules/webhooks/razorpay/handler.ts
//
// THE most critical file in the Razorpay integration. Every payment outcome
// — manual order, autopay charge, subscription lifecycle event — arrives here.
//
// ── CRITICAL RULES ─────────────────────────────────────────────────────────
// 1. ALWAYS verify the X-Razorpay-Signature header before touching any DB.
//    Use the raw request body string, never re-serialised JSON.
//
// 2. ALWAYS check idempotency before acting. Razorpay may send the same
//    webhook multiple times and does not guarantee delivery order.
//
// 3. NEVER let a FAILED event downgrade an already-CAPTURED payment.
//
// 4. Return HTTP 200 immediately on any duplicate or already-processed event.
//    Returning non-200 causes Razorpay to retry, which creates noise.
//
// 5. Wrap every side-effect in a DB transaction. If granting access and the
//    transaction fails, the next webhook retry will re-run it cleanly.
// ───────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import {
  platformPaymentsSchema,
  schoolAccessPeriodsSchema,
  schoolAutopaySubscriptionsSchema,
  schoolBundlePurchasesSchema,
  schoolsSchema,
  schoolInvitationsSchema,
} from "../../../db/schemas/super";
import { getRazorpayService } from "../../../services/razorpay/razorpay-service";
import { getCommonDB } from "../../../db";
import { getSchoolDB } from "../../../db/school-client";
import { grantAccessPeriod } from "../../../utils/access-periods";
import {
  AccessPlanTypeValue,
  AutopaySubscriptionStatus,
  AutopaySubscriptionStatusValue,
  PaymentSource,
  PaymentType,
  PlatformPaymentStatus,
} from "../../../types/razorpay";
import { Env } from "../../../types/common-types";
import {
  whatsappBalanceSchema,
  whatsappBundleCreditsSchema,
} from "../../../db/schemas/school";

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK ENTRY POINT
// Called by the route with the raw body string and the signature header.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleRazorpayWebhook(
  env: Env["Bindings"],
  rawBody: string,
  signature: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // ── Step 1: Verify signature ──────────────────────────────────────────────
  const razorpay = getRazorpayService(env as any);
  const isValid = razorpay.verifyWebhookSignature(rawBody, signature);
  if (!isValid) {
    console.error("Webhook signature verification FAILED");
    return { status: 400, body: { error: "Invalid signature" } };
  }

  // ── Step 2: Parse payload ─────────────────────────────────────────────────
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }

  const event: string = payload?.event ?? "";

  // Extract the primary entity for logging. The exact nesting differs by event:
  //   payment.*       → payload.payload.payment.entity
  //   order.*         → payload.payload.order.entity
  //   subscription.*  → payload.payload.subscription.entity
  const primaryEntity =
    payload?.payload?.payment?.entity ??
    payload?.payload?.subscription?.entity ??
    payload?.payload?.order?.entity ??
    {};

  console.log(`[Webhook] event=${event} entity_id=${primaryEntity.id ?? "n/a"}`);

  // ── Step 3: Route to the correct handler ─────────────────────────────────
  try {
    if (event.startsWith("payment.")) {
      return await handlePaymentEvent(env, event, payload);
    }
    if (event.startsWith("order.")) {
      return await handleOrderEvent(env, event, payload);
    }
    if (event.startsWith("subscription.")) {
      return await handleSubscriptionEvent(env, event, payload);
    }

    // Unknown event — acknowledge so Razorpay stops retrying.
    // This is the correct response for all the events we don't handle:
    // payment.authorized, payment.dispute.*, settlement.processed, etc.
    return { status: 200, body: { received: true, action: "ignored", event } };
  } catch (err: any) {
    console.error(`[Webhook] Unhandled error for event ${event}:`, err);
    // Return 200 so Razorpay does NOT retry indefinitely on bugs.
    return { status: 200, body: { received: true, error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER EVENTS
// ─────────────────────────────────────────────────────────────────────────────

async function handleOrderEvent(
  env: Env["Bindings"],
  event: string,
  payload: any
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (event !== "order.paid") {
    // order.notification.delivered / order.notification.failed — not relevant
    return { status: 200, body: { received: true, action: "ignored", event } };
  }

  // For order.paid, Razorpay provides BOTH the order entity and the payment
  // entity in the same payload. The notes we need for routing are on the ORDER.
  const orderEntity = payload?.payload?.order?.entity ?? {};
  const paymentEntity = payload?.payload?.payment?.entity;

  if (!paymentEntity) {
    console.warn("[Webhook] order.paid arrived without payment entity");
    return {
      status: 200,
      body: { received: true, action: "no_payment_entity" },
    };
  }

  // Notes live on the order entity for the Orders rail.
  // Pass them explicitly so handlePaymentCapture doesn't have to guess.
  const notes: Record<string, string> = orderEntity.notes ?? {};
  return handlePaymentCapture(env, paymentEntity, notes);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT EVENTS
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentEvent(
  env: Env["Bindings"],
  event: string,
  payload: any
): Promise<{ status: number; body: Record<string, unknown> }> {
  const paymentEntity = payload?.payload?.payment?.entity ?? {};

  if (event === "payment.captured") {
    // IMPORTANT: payment.captured fires for ALL payment types — Orders,
    // Payment Links, Subscription authorizations, etc. We only care about
    // payments tied to an Order on our Orders rail. If there's no order_id,
    // this is a different payment type (e.g. a Subscription auth payment
    // which is handled by subscription.charged instead). Silently ignore.
    if (!paymentEntity.order_id) {
      return {
        status: 200,
        body: {
          received: true,
          action: "ignored",
          reason: "no_order_id_not_our_order",
        },
      };
    }

    // For payment.captured on our Orders rail, notes are on the payment entity
    // (Razorpay copies order notes onto the payment). This is the fallback
    // path — order.paid is the preferred event and usually arrives first.
    // The idempotency guard in handlePaymentCapture prevents double-processing.
    const notes: Record<string, string> = paymentEntity.notes ?? {};
    return handlePaymentCapture(env, paymentEntity, notes);
  }

  if (event === "payment.failed") {
    // payment.failed fires for failed payment attempts against our Orders.
    // payment.authorized is NOT handled — we use auto-capture (payment_capture: 1
    // on order creation), so payments go straight from created → captured,
    // and we never need to manually capture them.
    return handlePaymentFailed(env, paymentEntity);
  }

  // payment.authorized            — not handled (auto-capture is enabled)
  // payment.dispute.*             — dispute management is done manually in Razorpay dashboard
  // payment.downtime.*            — operational alerts, no DB action needed
  return { status: 200, body: { received: true, action: "ignored", event } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE CAPTURE HANDLER — called by both order.paid and payment.captured
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentCapture(
  env: Env["Bindings"],
  paymentEntity: any,
  notes: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getCommonDB(env);
  const orderId: string = paymentEntity.order_id;
  const paymentId: string = paymentEntity.id;
  const paymentType = notes.paymentType as string;

  // Both order.paid and payment.captured should always have an order_id by
  // the time they reach here — the callers guard this — but be defensive.
  if (!orderId || !paymentType) {
    console.warn(
      "[Webhook] handlePaymentCapture: missing order_id or paymentType in notes",
      { orderId, paymentType, paymentId }
    );
    return {
      status: 200,
      body: { received: true, action: "skipped_missing_notes" },
    };
  }

  // ── Idempotency: load existing platform_payments row ─────────────────────
  const existingPayment = await db
    .select()
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayOrderId, orderId))
    .get();

  if (!existingPayment) {
    // Payment created outside our system (Razorpay dashboard test, etc.)
    // Don't log as an error — this is expected during manual testing.
    console.warn(`[Webhook] No platform_payments row for order ${orderId} — skipping`);
    return { status: 200, body: { received: true, action: "no_record_found" } };
  }

  if (existingPayment.status === PlatformPaymentStatus.CAPTURED) {
    // Already processed — idempotent 200, do nothing.
    // This is the normal path when BOTH order.paid AND payment.captured fire
    // for the same successful payment.
    return {
      status: 200,
      body: { received: true, action: "already_captured" },
    };
  }

  const schoolId = existingPayment.schoolId;

  // ── Mark payment CAPTURED ─────────────────────────────────────────────────
  await db
    .update(platformPaymentsSchema)
    .set({
      status: PlatformPaymentStatus.CAPTURED,
      razorpayPaymentId: paymentId,
      method: paymentEntity.method,
      capturedAt: new Date().toISOString(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(platformPaymentsSchema.id, existingPayment.id));

  // ── Route to the right side-effect ───────────────────────────────────────
  switch (paymentType) {
    case PaymentType.SCHOOL_SETUP_FEE:
      await handleSetupFeeCapture(db, schoolId, notes);
      break;

    case PaymentType.ACCESS_MONTHLY:
    case PaymentType.ACCESS_YEARLY: {
      const planType: AccessPlanTypeValue =
        paymentType === PaymentType.ACCESS_MONTHLY ? "MONTHLY" : "YEARLY";
      const durationDays = parseInt(notes.durationDays || "30", 10);
      await grantAccessPeriod(db, {
        schoolId,
        planType,
        source: PaymentSource.MANUAL_ORDER,
        platformPaymentId: existingPayment.id,
        durationDays,
      });
      await db
        .update(schoolsSchema)
        .set({ isActive: true, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(schoolsSchema.id, schoolId));
      break;
    }

    case PaymentType.WHATSAPP_BUNDLE:
    case PaymentType.EMAIL_BUNDLE:
    case PaymentType.SMS_BUNDLE:
      await handleBundleCapture(env, db, schoolId, existingPayment.id);
      break;

    default:
      console.warn(`[Webhook] Unknown paymentType in notes: ${paymentType}`);
  }

  return {
    status: 200,
    body: { received: true, action: "captured", paymentType, orderId },
  };
}

async function handleSetupFeeCapture(
  db: any,
  schoolId: number,
  notes: Record<string, string>
): Promise<void> {
  const school = await db
    .select({ onboardingStatus: schoolsSchema.onboardingStatus })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, schoolId))
    .get();

  if (school && ["REGISTERED", "INVITED"].includes(school.onboardingStatus)) {
    await db
      .update(schoolsSchema)
      .set({
        onboardingStatus: "PAYMENT_SUBMITTED",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolsSchema.id, schoolId));

    await db
      .update(schoolInvitationsSchema)
      .set({ status: "PAYMENT_SUBMITTED", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schoolInvitationsSchema.schoolId, schoolId));
  }
}

async function handleBundleCapture(
  env: Env["Bindings"],
  db: any,
  schoolId: number,
  platformPaymentId: number
): Promise<void> {
  const purchase = await db
    .select()
    .from(schoolBundlePurchasesSchema)
    .where(eq(schoolBundlePurchasesSchema.platformPaymentId, platformPaymentId))
    .get();

  if (!purchase || purchase.status === "ACTIVE") return;

  await db
    .update(schoolBundlePurchasesSchema)
    .set({ status: "ACTIVE" })
    .where(eq(schoolBundlePurchasesSchema.id, purchase.id));

  const school = await db
    .select({ uniqueCode: schoolsSchema.uniqueCode })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, schoolId))
    .get();

  if (!school) return;

  if (purchase.channel === "WHATSAPP") {
    await creditWhatsappBalance(env, school.uniqueCode, purchase);
  }
}

async function creditWhatsappBalance(
  env: Env["Bindings"],
  schoolCode: string,
  purchase: any
): Promise<void> {
  try {
    const schoolDb = await getSchoolDB(env, schoolCode);

    await schoolDb.transaction(async (tx: any) => {
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

      await tx.insert(whatsappBundleCreditsSchema).values({
        superBundlePurchaseId: purchase.id,
        creditsAdded: purchase.creditsAdded,
        creditsRemaining: purchase.creditsAdded,
        expiresAt: purchase.expiresAt,
        isExpired: false,
        purchasedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error(
      `[Webhook] Failed to credit WhatsApp balance for school ${schoolCode}:`,
      err
    );
  }
}

async function handlePaymentFailed(
  env: Env["Bindings"],
  paymentEntity: any
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getCommonDB(env);
  const orderId = paymentEntity.order_id;

  // payment.failed with no order_id means it's not from our Orders rail
  // (could be a failed Subscription auth attempt). Ignore cleanly.
  if (!orderId) {
    return {
      status: 200,
      body: {
        received: true,
        action: "ignored",
        reason: "no_order_id_not_our_order",
      },
    };
  }

  const existing = await db
    .select({
      id: platformPaymentsSchema.id,
      status: platformPaymentsSchema.status,
    })
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayOrderId, orderId))
    .get();

  if (!existing) {
    return { status: 200, body: { received: true, action: "no_record" } };
  }

  // NEVER downgrade from CAPTURED to FAILED.
  // This guards against out-of-order delivery where a failed attempt's webhook
  // arrives after a successful retry's webhook.
  if (existing.status === PlatformPaymentStatus.CAPTURED) {
    return {
      status: 200,
      body: { received: true, action: "already_captured_skip_failed" },
    };
  }

  await db
    .update(platformPaymentsSchema)
    .set({
      status: PlatformPaymentStatus.FAILED,
      failureReason:
        paymentEntity.error_description ||
        paymentEntity.error_code ||
        "Payment failed",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(platformPaymentsSchema.id, existing.id));

  return { status: 200, body: { received: true, action: "marked_failed" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIPTION EVENTS (Autopay rail)
// ─────────────────────────────────────────────────────────────────────────────

async function handleSubscriptionEvent(
  env: Env["Bindings"],
  event: string,
  payload: any
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getCommonDB(env);
  const subscriptionEntity = payload?.payload?.subscription?.entity ?? {};
  const subscriptionId: string = subscriptionEntity.id;
  const notes: Record<string, string> = subscriptionEntity.notes ?? {};

  if (!subscriptionId) {
    console.warn("[Webhook] subscription event missing subscription entity id");
    return { status: 200, body: { received: true, action: "no_subscription_id" } };
  }

  const subRecord = await db
    .select()
    .from(schoolAutopaySubscriptionsSchema)
    .where(
      eq(
        schoolAutopaySubscriptionsSchema.razorpaySubscriptionId,
        subscriptionId
      )
    )
    .get();

  if (!subRecord) {
    console.warn(`[Webhook] No subscription record for ${subscriptionId}`);
    return { status: 200, body: { received: true, action: "no_record" } };
  }

  // Status-only lifecycle updates — no access side-effects, just tracking
  const statusOnlyEvents: Record<string, AutopaySubscriptionStatusValue> = {
    "subscription.authenticated": AutopaySubscriptionStatus.AUTHENTICATED,
    "subscription.activated": AutopaySubscriptionStatus.ACTIVE,
    "subscription.pending": AutopaySubscriptionStatus.PENDING,
    "subscription.halted": AutopaySubscriptionStatus.HALTED,
    "subscription.paused": AutopaySubscriptionStatus.PAUSED,
    "subscription.resumed": AutopaySubscriptionStatus.ACTIVE,
    "subscription.completed": AutopaySubscriptionStatus.COMPLETED,
    "subscription.cancelled": AutopaySubscriptionStatus.CANCELLED,
    "subscription.expired": AutopaySubscriptionStatus.EXPIRED,
  };

  if (statusOnlyEvents[event]) {
    const newStatus = statusOnlyEvents[event];
    const setFields: any = {
      status: newStatus,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    };

    if (subscriptionEntity.current_start) {
      setFields.currentPeriodStart = new Date(
        subscriptionEntity.current_start * 1000
      ).toISOString();
    }
    if (subscriptionEntity.current_end) {
      setFields.currentPeriodEnd = new Date(
        subscriptionEntity.current_end * 1000
      ).toISOString();
    }
    if (subscriptionEntity.charge_at) {
      setFields.nextChargeAt = String(subscriptionEntity.charge_at);
    }
    if (event === "subscription.cancelled") {
      setFields.cancelledAt = new Date().toISOString();
    }

    await db
      .update(schoolAutopaySubscriptionsSchema)
      .set(setFields)
      .where(eq(schoolAutopaySubscriptionsSchema.id, subRecord.id));

    if (event === "subscription.halted") {
      console.warn(
        `[Webhook] Autopay HALTED for school ${subRecord.schoolId} — access will lapse on next expiry`
      );
    }

    return {
      status: 200,
      body: { received: true, action: "status_updated", event },
    };
  }

  // ── subscription.charged — the actual money event ─────────────────────────
  if (event === "subscription.charged") {
    return handleSubscriptionCharge(
      env,
      db,
      subRecord,
      subscriptionEntity,
      payload,
      notes
    );
  }

  return { status: 200, body: { received: true, action: "ignored", event } };
}

async function handleSubscriptionCharge(
  env: Env["Bindings"],
  db: any,
  subRecord: typeof schoolAutopaySubscriptionsSchema.$inferSelect,
  subscriptionEntity: any,
  payload: any,
  notes: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const paymentEntity = payload?.payload?.payment?.entity ?? {};
  const paymentId: string = paymentEntity.id;
  const amountPaise: number = paymentEntity.amount ?? 0;

  if (!paymentId) {
    return { status: 200, body: { received: true, action: "no_payment_id" } };
  }

  const existing = await db
    .select({
      id: platformPaymentsSchema.id,
      status: platformPaymentsSchema.status,
    })
    .from(platformPaymentsSchema)
    .where(eq(platformPaymentsSchema.razorpayPaymentId, paymentId))
    .get();

  if (existing && existing.status === PlatformPaymentStatus.CAPTURED) {
    return {
      status: 200,
      body: { received: true, action: "already_processed" },
    };
  }

  const planType: AccessPlanTypeValue =
    (notes.planType as AccessPlanTypeValue) || subRecord.planType;
  const durationDays = parseInt(notes.durationDays || "30", 10);
  const paymentType =
    planType === "MONTHLY"
      ? PaymentType.ACCESS_MONTHLY
      : PaymentType.ACCESS_YEARLY;

  await db.transaction(async (tx: any) => {
    const [payment] = await tx
      .insert(platformPaymentsSchema)
      .values({
        schoolId: subRecord.schoolId,
        razorpaySubscriptionId: subRecord.razorpaySubscriptionId,
        razorpayPaymentId: paymentId,
        source: PaymentSource.AUTOPAY_CHARGE,
        paymentType,
        amountPaise,
        currency: "INR",
        status: PlatformPaymentStatus.CAPTURED,
        method: paymentEntity.method ?? "upi",
        capturedAt: new Date().toISOString(),
        description: `Auto-renewal ${planType} — school ${subRecord.schoolId}`,
        metaJson: JSON.stringify({
          planType,
          durationDays,
          subscriptionId: subRecord.razorpaySubscriptionId,
        }),
      })
      .returning({ id: platformPaymentsSchema.id });

    await grantAccessPeriod(tx, {
      schoolId: subRecord.schoolId,
      planType,
      source: PaymentSource.AUTOPAY_CHARGE,
      platformPaymentId: payment.id,
      durationDays,
    });

    await tx
      .update(schoolsSchema)
      .set({ isActive: true, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schoolsSchema.id, subRecord.schoolId));

    await tx
      .update(schoolAutopaySubscriptionsSchema)
      .set({
        status: AutopaySubscriptionStatus.ACTIVE,
        paidCount: subRecord.paidCount + 1,
        currentPeriodStart: subscriptionEntity.current_start
          ? new Date(subscriptionEntity.current_start * 1000).toISOString()
          : null,
        currentPeriodEnd: subscriptionEntity.current_end
          ? new Date(subscriptionEntity.current_end * 1000).toISOString()
          : null,
        nextChargeAt: subscriptionEntity.charge_at
          ? String(subscriptionEntity.charge_at)
          : null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolAutopaySubscriptionsSchema.id, subRecord.id));
  });

  return {
    status: 200,
    body: { received: true, action: "access_granted", planType, durationDays },
  };
}