// src/modules/super/message-bundles/services.ts

import { eq, sql } from "drizzle-orm";
import { messageBundlesSchema } from "../../../db/schemas/super";
import { Env } from "../../../types/common-types";
import { MessageChannelValue } from "../../../types/razorpay";
import { getCommonDB } from "../../../db";

export async function getAllBundles(
  env: Env["Bindings"],
  channel?: MessageChannelValue
) {
  const db = getCommonDB(env);
  const query = db
    .select()
    .from(messageBundlesSchema)
    .orderBy(messageBundlesSchema.sortOrder);

  return channel
    ? query.where(eq(messageBundlesSchema.channel, channel)).all()
    : query.all();
}

export async function getBundleById(env: Env["Bindings"], id: number) {
  const db = getCommonDB(env);
  return db
    .select()
    .from(messageBundlesSchema)
    .where(eq(messageBundlesSchema.id, id))
    .get();
}

interface CreateBundleInput {
  channel: MessageChannelValue;
  name: string;
  messageCount: number;
  amountPaise: number;
  discountPaise?: number;
  validityDays?: number;
  sortOrder?: number;
}

export async function createBundle(
  env: Env["Bindings"],
  data: CreateBundleInput
) {
  const db = getCommonDB(env);

  const discountPaise = data.discountPaise ?? 0;
  if (discountPaise < 0 || discountPaise > data.amountPaise) {
    throw new Error("Discount must be between 0 and the bundle's amount.");
  }

  const [newBundle] = await db
    .insert(messageBundlesSchema)
    .values({
      channel: data.channel,
      name: data.name,
      messageCount: data.messageCount,
      amountPaise: data.amountPaise,
      discountPaise,
      finalAmountPaise: data.amountPaise - discountPaise,
      validityDays: data.validityDays ?? 365,
      sortOrder: data.sortOrder ?? 0,
      isActive: true,
    })
    .returning();

  return newBundle;
}

interface UpdateBundleInput {
  name?: string;
  messageCount?: number;
  amountPaise?: number;
  discountPaise?: number;
  validityDays?: number;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * Updates a bundle and recomputes finalAmountPaise. Unlike access plans,
 * bundles have NO Razorpay-side Plan object to worry about — every
 * purchase is a fresh Order at purchase time, so a discount or price
 * change here takes effect immediately for the very next purchase with
 * zero Razorpay-side caveats.
 */
export async function updateBundle(
  env: Env["Bindings"],
  id: number,
  data: UpdateBundleInput
) {
  const db = getCommonDB(env);

  return db.transaction(async (tx: any) => {
    const existing = await tx
      .select()
      .from(messageBundlesSchema)
      .where(eq(messageBundlesSchema.id, id))
      .get();

    if (!existing) throw new Error("Bundle not found");

    const newAmountPaise = data.amountPaise ?? existing.amountPaise;
    const newDiscountPaise = data.discountPaise ?? existing.discountPaise;

    if (newDiscountPaise < 0 || newDiscountPaise > newAmountPaise) {
      throw new Error("Discount must be between 0 and the bundle's amount.");
    }

    await tx
      .update(messageBundlesSchema)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.messageCount !== undefined && {
          messageCount: data.messageCount,
        }),
        amountPaise: newAmountPaise,
        discountPaise: newDiscountPaise,
        finalAmountPaise: newAmountPaise - newDiscountPaise,
        ...(data.validityDays !== undefined && {
          validityDays: data.validityDays,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(messageBundlesSchema.id, id));

    return tx
      .select()
      .from(messageBundlesSchema)
      .where(eq(messageBundlesSchema.id, id))
      .get();
  });
}

export async function deleteBundle(env: Env["Bindings"], id: number) {
  const db = getCommonDB(env);
  // Soft-delete via isActive=false rather than hard delete — preserves
  // referential integrity for school_bundle_purchases history.
  await db
    .update(messageBundlesSchema)
    .set({ isActive: false, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(messageBundlesSchema.id, id));
  return { message: "Bundle deactivated successfully" };
}
