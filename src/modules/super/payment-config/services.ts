// src/modules/super/payment-config/services.ts

import { eq, sql } from "drizzle-orm";
import { paymentConfigSchema } from "../../../db/schemas/super";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";

/**
 * PAYMENT CONFIG SERVICE — manages the single-row payment_config table.
 * Row id=1 always. Covers BOTH the legacy manual-UTR fields (upiId,
 * qrCodeUrl — kept for backward compatibility with schools mid-onboarding
 * on the old flow) and the new Razorpay setup-fee discount fields.
 *
 * setupFeeFinalAmountPaise is ALWAYS recomputed server-side here — never
 * accept it directly from a request body. This is the value the setup-fee
 * Order service reads when creating a Razorpay Order; changing the
 * discount here takes effect on the very next school that pays, instantly,
 * since the setup fee uses the Orders rail only (no Razorpay Plan, no
 * immutability concern at all).
 */

export async function getPaymentConfig(env: Env["Bindings"]) {
  const db = getCommonDB(env);
  let config = await db
    .select()
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  // Lazily create the row if it has never been initialised — keeps this
  // service safe to call from anywhere without a separate seed step.
  if (!config) {
    const [created] = await db
      .insert(paymentConfigSchema)
      .values({
        id: 1,
        setupFeeAmount: 0,
        setupFeeDiscountPaise: 0,
        setupFeeFinalAmountPaise: 0,
        isFeeEnabled: false,
      })
      .returning();
    config = created;
  }

  return config;
}

interface UpdatePaymentConfigInput {
  upiId?: string;
  qrCodeUrl?: string;
  setupFeeAmount?: number;
  setupFeeDiscountPaise?: number;
  currency?: string;
  feeDescription?: string;
  isFeeEnabled?: boolean;
}

export async function updatePaymentConfig(
  env: Env["Bindings"],
  data: UpdatePaymentConfigInput
) {
  const db = getCommonDB(env);

  return db.transaction(async (tx: any) => {
    let existing = await tx
      .select()
      .from(paymentConfigSchema)
      .where(eq(paymentConfigSchema.id, 1))
      .get();

    if (!existing) {
      const [created] = await tx
        .insert(paymentConfigSchema)
        .values({
          id: 1,
          setupFeeAmount: 0,
          setupFeeDiscountPaise: 0,
          setupFeeFinalAmountPaise: 0,
          isFeeEnabled: false,
        })
        .returning();
      existing = created;
    }

    const newSetupFeeAmount = data.setupFeeAmount ?? existing.setupFeeAmount;
    const newDiscountPaise =
      data.setupFeeDiscountPaise ?? existing.setupFeeDiscountPaise;

    if (newDiscountPaise < 0 || newDiscountPaise > newSetupFeeAmount) {
      throw new Error(
        "Setup fee discount must be between 0 and the setup fee amount."
      );
    }

    await tx
      .update(paymentConfigSchema)
      .set({
        ...(data.upiId !== undefined && { upiId: data.upiId }),
        ...(data.qrCodeUrl !== undefined && { qrCodeUrl: data.qrCodeUrl }),
        setupFeeAmount: newSetupFeeAmount,
        setupFeeDiscountPaise: newDiscountPaise,
        setupFeeFinalAmountPaise: newSetupFeeAmount - newDiscountPaise,
        ...(data.currency !== undefined && { currency: data.currency }),
        ...(data.feeDescription !== undefined && {
          feeDescription: data.feeDescription,
        }),
        ...(data.isFeeEnabled !== undefined && {
          isFeeEnabled: data.isFeeEnabled,
        }),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(paymentConfigSchema.id, 1));

    return tx
      .select()
      .from(paymentConfigSchema)
      .where(eq(paymentConfigSchema.id, 1))
      .get();
  });
}
