// src/modules/super/payment-config/services.ts

import { eq, sql } from "drizzle-orm";
import { paymentConfigSchema } from "../../../db/schemas/super/payment-config";

export async function getPaymentConfig(db: any) {
  const config = await db
    .select()
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  // Return defaults if not yet configured
  if (!config) {
    return {
      id: null,
      upiId: "",
      qrCodeUrl: "",
      setupFeeAmount: 0,
      currency: "INR",
      feeDescription:
        "One-time school setup fee — includes onboarding support by our team",
      isFeeEnabled: true,
    };
  }

  return config;
}

export async function upsertPaymentConfig(
  db: any,
  data: {
    upiId: string;
    qrCodeUrl?: string;
    setupFeeAmount: number;
    currency?: string;
    feeDescription: string;
    isFeeEnabled: boolean;
  }
) {
  const existing = await db
    .select({ id: paymentConfigSchema.id })
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  if (existing) {
    const [updated] = await db
      .update(paymentConfigSchema)
      .set({
        ...data,
        qrCodeUrl: data.qrCodeUrl || "",
        currency: data.currency || "INR",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(paymentConfigSchema.id, 1))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(paymentConfigSchema)
    .values({
      id: 1,
      ...data,
      qrCodeUrl: data.qrCodeUrl || "",
      currency: data.currency || "INR",
    })
    .returning();
  return created;
}
