/**
 * src/types/razorpay.ts
 *
 * Shared domain types for the Razorpay integration. These are NOT Razorpay's
 * own API response types (those are imported from the `razorpay` SDK or typed
 * ad-hoc at the call site) — these are OUR internal vocabulary, used across
 * the super-admin payment-config/access-plans/bundles modules and the
 * school-facing payments/billing modules.
 *
 * ── TWO PAYMENT RAILS, ONE LEDGER ─────────────────────────────────────────
 * Every payment, regardless of which rail produced it, is recorded in
 * `platform_payments`. The rail only determines HOW the money arrived:
 *
 *   MANUAL_ORDER   → Razorpay Orders API. School pays once, manually, via
 *                    Checkout (UPI / card / netbanking). Used for setup fee,
 *                    message bundles, AND access plans when the school does
 *                    not want auto-renewal.
 *
 *   AUTOPAY_CHARGE → Razorpay Subscriptions API with UPI Autopay. Used ONLY
 *                    for access plans (Monthly/Yearly), and only when the
 *                    school explicitly opts in. Razorpay auto-charges on
 *                    schedule; each successful charge writes a new
 *                    `school_access_periods` row exactly like a manual order
 *                    would.
 *
 * Access control (`requireActiveAccess` middleware) NEVER inspects which
 * rail funded a period — it only ever reads `school_access_periods.expiresAt`.
 * ────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────
// PAYMENT TYPE — what the money is FOR (drives webhook routing via
// notes.paymentType, and is stored verbatim on platform_payments.paymentType)
// ─────────────────────────────────────────────────────────────────────────
export const PaymentType = {
  SCHOOL_SETUP_FEE: "SCHOOL_SETUP_FEE",
  ACCESS_MONTHLY: "ACCESS_MONTHLY",
  ACCESS_YEARLY: "ACCESS_YEARLY",
  WHATSAPP_BUNDLE: "WHATSAPP_BUNDLE",
  EMAIL_BUNDLE: "EMAIL_BUNDLE", // future
  SMS_BUNDLE: "SMS_BUNDLE", // future
} as const;
export type PaymentTypeValue = (typeof PaymentType)[keyof typeof PaymentType];

/** Payment types that represent access-plan purchases (monthly/yearly portal access). */
export const ACCESS_PAYMENT_TYPES: readonly PaymentTypeValue[] = [
  PaymentType.ACCESS_MONTHLY,
  PaymentType.ACCESS_YEARLY,
];

/** Payment types that represent a message-bundle purchase, keyed by channel. */
export const BUNDLE_PAYMENT_TYPE_BY_CHANNEL: Record<
  MessageChannelValue,
  PaymentTypeValue
> = {
  WHATSAPP: PaymentType.WHATSAPP_BUNDLE,
  EMAIL: PaymentType.EMAIL_BUNDLE,
  SMS: PaymentType.SMS_BUNDLE,
};

// ─────────────────────────────────────────────────────────────────────────
// PAYMENT RAIL — HOW the money arrived
// ─────────────────────────────────────────────────────────────────────────
export const PaymentSource = {
  MANUAL_ORDER: "MANUAL_ORDER",
  AUTOPAY_CHARGE: "AUTOPAY_CHARGE",
} as const;
export type PaymentSourceValue =
  (typeof PaymentSource)[keyof typeof PaymentSource];

// ─────────────────────────────────────────────────────────────────────────
// PLATFORM PAYMENT STATUS — lifecycle of a single platform_payments row
// ─────────────────────────────────────────────────────────────────────────
export const PlatformPaymentStatus = {
  CREATED: "CREATED", // Order/charge attempt created, awaiting payment
  AUTHORIZED: "AUTHORIZED", // Payment authorized but not yet captured (manual capture flows)
  CAPTURED: "CAPTURED", // Successfully captured — the only "money received" state
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type PlatformPaymentStatusValue =
  (typeof PlatformPaymentStatus)[keyof typeof PlatformPaymentStatus];

// ─────────────────────────────────────────────────────────────────────────
// ACCESS PLAN TYPE — exactly two rows ever exist in access_plans
// ─────────────────────────────────────────────────────────────────────────
export const AccessPlanType = {
  MONTHLY: "MONTHLY",
  YEARLY: "YEARLY",
} as const;
export type AccessPlanTypeValue =
  (typeof AccessPlanType)[keyof typeof AccessPlanType];

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE CHANNEL — WhatsApp now, Email/SMS later. Same bundle shape for all.
// ─────────────────────────────────────────────────────────────────────────
export const MessageChannel = {
  WHATSAPP: "WHATSAPP",
  EMAIL: "EMAIL",
  SMS: "SMS",
} as const;
export type MessageChannelValue =
  (typeof MessageChannel)[keyof typeof MessageChannel];

// ─────────────────────────────────────────────────────────────────────────
// BUNDLE PURCHASE STATUS
// ─────────────────────────────────────────────────────────────────────────
export const BundlePurchaseStatus = {
  PENDING: "PENDING", // Order created, payment not yet confirmed
  ACTIVE: "ACTIVE", // Payment captured, credits live in school's Turso DB
  EXPIRED: "EXPIRED", // validityDays elapsed, credits no longer usable
  REFUNDED: "REFUNDED",
} as const;
export type BundlePurchaseStatusValue =
  (typeof BundlePurchaseStatus)[keyof typeof BundlePurchaseStatus];

// ─────────────────────────────────────────────────────────────────────────
// AUTOPAY (RAZORPAY SUBSCRIPTION) STATUS
// Mirrors Razorpay's own subscription lifecycle values verbatim — see
// https://razorpay.com/docs/payments/subscriptions/states/
// This status is informational/management-only. It is NEVER read by the
// access-control middleware — only `school_access_periods.expiresAt` is.
// ─────────────────────────────────────────────────────────────────────────
export const AutopaySubscriptionStatus = {
  CREATED: "created",
  AUTHENTICATED: "authenticated",
  ACTIVE: "active",
  PENDING: "pending",
  HALTED: "halted",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  PAUSED: "paused",
  EXPIRED: "expired",
} as const;
export type AutopaySubscriptionStatusValue =
  (typeof AutopaySubscriptionStatus)[keyof typeof AutopaySubscriptionStatus];

// ─────────────────────────────────────────────────────────────────────────
// RAZORPAY NOTES SHAPES — what we attach to `notes` on every Order/Subscription
// so the single webhook endpoint can route purely off the payload, without
// needing a DB lookup just to know what kind of payment this is.
// All values must be strings — Razorpay's `notes` field only accepts
// string values (max 15 key-value pairs).
// ─────────────────────────────────────────────────────────────────────────

export interface SetupFeeOrderNotes {
  paymentType: "SCHOOL_SETUP_FEE";
  schoolId: string;
  invitationId: string;
}

export interface AccessOrderNotes {
  paymentType: "ACCESS_MONTHLY" | "ACCESS_YEARLY";
  schoolId: string;
  accessPlanId: string;
  planType: AccessPlanTypeValue;
  durationDays: string;
}

export interface BundleOrderNotes {
  paymentType: "WHATSAPP_BUNDLE" | "EMAIL_BUNDLE" | "SMS_BUNDLE";
  schoolId: string;
  bundleId: string;
  channel: MessageChannelValue;
  creditsToAdd: string;
  validityDays: string;
}

export type RazorpayOrderNotes =
  | SetupFeeOrderNotes
  | AccessOrderNotes
  | BundleOrderNotes;

/** Notes attached to an Autopay Subscription (always an access plan). */
export interface AccessSubscriptionNotes {
  paymentType: "ACCESS_MONTHLY" | "ACCESS_YEARLY";
  schoolId: string;
  accessPlanId: string;
  planType: AccessPlanTypeValue;
  durationDays: string;
  rail: "AUTOPAY_CHARGE";
}

// ─────────────────────────────────────────────────────────────────────────
// SERVICE-LAYER INPUT/RESULT SHAPES
// ─────────────────────────────────────────────────────────────────────────

/** Standard shape returned to the frontend after creating any Razorpay Order. */
export interface CreateOrderResult {
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  keyId: string; // Razorpay key_id — safe to expose to frontend, used by Checkout
  platformPaymentId: number; // our own ledger row id, for client-side reference
}

/** Standard shape returned to the frontend after creating an Autopay Subscription. */
export interface CreateAutopaySubscriptionResult {
  razorpaySubscriptionId: string;
  keyId: string;
  amountPaise: number; // first-charge amount, for display only
  currency: string;
}

/** Verification payload sent from Angular after Razorpay Checkout success (Orders). */
export interface VerifyOrderPaymentInput {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/** Verification payload sent from Angular after Razorpay Checkout success (Subscriptions). */
export interface VerifySubscriptionPaymentInput {
  razorpaySubscriptionId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

/** Internal result of resolving notes off an incoming webhook payload. */
export interface ResolvedWebhookContext {
  paymentType: PaymentTypeValue;
  schoolId: number;
  raw: Record<string, string>;
}
