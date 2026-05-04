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
  setupFeeAmount: integer("setup_fee_amount").notNull().default(0), // In paise (INR), e.g. 500000 = ₹5000
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
