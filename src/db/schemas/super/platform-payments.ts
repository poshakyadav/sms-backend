// src/db/schemas/super/platform-payments.ts

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import {
  PaymentSourceValue,
  PaymentTypeValue,
  PlatformPaymentStatusValue,
} from "../../../types/razorpay";

/**
 * PLATFORM PAYMENTS — the unified ledger. Every Razorpay payment, regardless
 * of paymentType (setup fee / access plan / message bundle) or rail
 * (manual order / autopay charge), gets exactly one row here.
 *
 * This is intentionally THE single table your billing-history screen,
 * reconciliation reports, and refund tooling query — one table, one shape,
 * doesn't matter how the money arrived.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * `webhookEventId` is the de-duplication key for the webhook handler.
 * Razorpay does not guarantee webhook delivery exactly once, nor does it
 * guarantee delivery order (a `payment.failed` for an earlier attempt can
 * arrive after a `payment.captured` for a later, successful one). The
 * webhook handler MUST:
 *   1. Look up the existing row by razorpayOrderId (or razorpaySubscriptionId
 *      for autopay charges).
 *   2. If the row's status is already CAPTURED, treat any further webhook
 *      for that same payment attempt as a no-op (return 200 immediately).
 *   3. Never let a FAILED event downgrade an already-CAPTURED row.
 * See src/modules/webhooks/razorpay/services.ts for the exact guard.
 */
export const platformPaymentsSchema = sqliteTable(
  "platform_payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    /** Set for MANUAL_ORDER rail payments. NULL for autopay charges. */
    razorpayOrderId: text("razorpay_order_id"),

    /** Set for AUTOPAY_CHARGE rail payments. NULL for manual orders. */
    razorpaySubscriptionId: text("razorpay_subscription_id"),

    /** Set once Checkout completes / a charge succeeds. */
    razorpayPaymentId: text("razorpay_payment_id"),

    /** Signature received from Checkout/webhook, kept for audit trail. */
    razorpaySignature: text("razorpay_signature"),

    /** "MANUAL_ORDER" | "AUTOPAY_CHARGE" */
    source: text("source").$type<PaymentSourceValue>().notNull(),

    /** "SCHOOL_SETUP_FEE" | "ACCESS_MONTHLY" | "ACCESS_YEARLY" | "WHATSAPP_BUNDLE" | "EMAIL_BUNDLE" | "SMS_BUNDLE" */
    paymentType: text("payment_type").$type<PaymentTypeValue>().notNull(),

    /** Exact amount charged, in paise. Always sourced server-side from the
     *  relevant finalAmountPaise field — never from client input. */
    amountPaise: integer("amount_paise").notNull(),

    currency: text("currency").notNull().default("INR"),

    /** "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED" */
    status: text("status").$type<PlatformPaymentStatusValue>().notNull(),

    /** Payment method used, populated from webhook payload: card/upi/netbanking/wallet. */
    method: text("method"),

    /** Human-readable description shown on billing history, e.g. "WhatsApp Pro 2000 Bundle". */
    description: text("description").notNull(),

    /** JSON blob — bundle details, plan details, discount snapshot at time of purchase, etc. */
    metaJson: text("meta_json").default("{}"),

    /**
     * De-duplication key for the webhook handler. We store a composite of
     * (entity type + entity id + event name) rather than relying on a
     * single Razorpay-provided event id field, since Razorpay's webhook
     * payload shape varies slightly by event. See webhook service for the
     * exact key construction. Unique-indexed implicitly by lookup pattern
     * in the service layer (checked via SELECT before INSERT/UPDATE, not a
     * DB-level unique constraint, since the same payment legitimately
     * receives multiple DIFFERENT webhook events over its lifecycle).
     */
    webhookEventId: text("webhook_event_id"),

    failureReason: text("failure_reason"),

    capturedAt: text("captured_at"),
    refundedAt: text("refunded_at"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    schoolIdx: index("idx_platform_payments_school").on(table.schoolId),
    orderIdx: index("idx_platform_payments_order").on(table.razorpayOrderId),
    subscriptionIdx: index("idx_platform_payments_subscription").on(
      table.razorpaySubscriptionId
    ),
    statusIdx: index("idx_platform_payments_status").on(table.status),
  })
);

export type PlatformPayment = typeof platformPaymentsSchema.$inferSelect;
export type NewPlatformPayment = typeof platformPaymentsSchema.$inferInsert;
