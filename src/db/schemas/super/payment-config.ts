import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Single-row config table. Super admin sets UPI ID, QR code URL, and fee amount here.
 * Only one row should ever exist (id=1). Upserted on every save.
 */
export const paymentConfigSchema = sqliteTable("payment_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  upiId: text("upi_id").notNull().default(""),
  qrCodeUrl: text("qr_code_url").default(""),

  // ── Setup fee — sticker price + discount + computed final amount ─────────
  setupFeeAmount: integer("setup_fee_amount").notNull().default(0), // In paise (INR), e.g. 500000 = ₹5000

  /**
   * Flat discount applied to the setup fee, in paise. Default 0 = no discount.
   * Editable by super admin via PUT /super/payment-config.
   */
  setupFeeDiscountPaise: integer("setup_fee_discount_paise")
    .notNull()
    .default(0),

  /**
   * Computed & persisted: setupFeeAmount - setupFeeDiscountPaise.
   * This is the ONLY amount used when creating the Razorpay Order for the
   * setup fee. Recomputed server-side on every update — never trust a
   * client-submitted value for this field.
   */
  setupFeeFinalAmountPaise: integer("setup_fee_final_amount_paise")
    .notNull()
    .default(0),
  
  currency: text("currency").notNull().default("INR"),
  feeDescription: text("fee_description")
    .notNull()
    .default(
      "One-time school setup fee — includes onboarding support by our team"
    ),
  isFeeEnabled: integer("is_fee_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type PaymentConfig = typeof paymentConfigSchema.$inferSelect;
export type NewPaymentConfig = typeof paymentConfigSchema.$inferInsert;
