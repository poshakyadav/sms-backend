// src/modules/super/auth/razorpay-seeder.ts
//
// Call seedRazorpayDefaults() from your existing seedSuperPermissionsAndRoles()
// or from your setup route. It is fully idempotent — safe to call on every
// boot; will no-op if rows already exist.

import {
  accessPlansSchema,
  messageBundlesSchema,
} from "../../../db/schemas/super";

/**
 * Seeds the two access plan rows (MONTHLY / YEARLY) and a default set of
 * WhatsApp message bundles if they don't already exist.
 *
 * Access plans are immutable after seeding — amountPaise and planType are
 * fixed. Only discountPaise and autopayEnabled are editable post-seed.
 */
export async function seedRazorpayDefaults(db: any): Promise<void> {
  await seedAccessPlans(db);
  await seedWhatsappBundles(db);
}

async function seedAccessPlans(db: any): Promise<void> {
  const existing = await db.select().from(accessPlansSchema).all();
  if (existing.length > 0) return; // Already seeded

  await db.insert(accessPlansSchema).values([
    {
      planType: "MONTHLY",
      name: "Monthly Access",
      amountPaise: 59900, // ₹599.00
      discountPaise: 0,
      finalAmountPaise: 59900,
      durationDays: 30,
      autopayEnabled: true,
      isActive: true,
    },
    {
      planType: "YEARLY",
      name: "Yearly Access",
      amountPaise: 898500, // ₹8985.00  (save ₹1203 vs 15 months)
      discountPaise: 0,
      finalAmountPaise: 898500,
      durationDays: 365,
      autopayEnabled: true,
      isActive: true,
    },
  ]);

  console.log("✅ Seeded access plans (MONTHLY ₹599, YEARLY ₹8985)");
}

async function seedWhatsappBundles(db: any): Promise<void> {
  const existing = await db.select().from(messageBundlesSchema).all();

  const hasWhatsapp = existing.some((b: any) => b.channel === "WHATSAPP");
  if (hasWhatsapp) return; // Already seeded

  await db.insert(messageBundlesSchema).values([
    {
      channel: "WHATSAPP",
      name: "WhatsApp Starter 200",
      messageCount: 200,
      amountPaise: 19900, // ₹199
      discountPaise: 0,
      finalAmountPaise: 19900,
      validityDays: 365,
      sortOrder: 1,
      isActive: true,
    },
    {
      channel: "WHATSAPP",
      name: "WhatsApp Basic 500",
      messageCount: 500,
      amountPaise: 39900, // ₹399
      discountPaise: 0,
      finalAmountPaise: 39900,
      validityDays: 365,
      sortOrder: 2,
      isActive: true,
    },
    {
      channel: "WHATSAPP",
      name: "WhatsApp Pro 2000",
      messageCount: 2000,
      amountPaise: 119900, // ₹1199
      discountPaise: 0,
      finalAmountPaise: 119900,
      validityDays: 365,
      sortOrder: 3,
      isActive: true,
    },
    {
      channel: "WHATSAPP",
      name: "WhatsApp Business 5000",
      messageCount: 5000,
      amountPaise: 249900, // ₹2499
      discountPaise: 0,
      finalAmountPaise: 249900,
      validityDays: 365,
      sortOrder: 4,
      isActive: true,
    },
  ]);

  console.log("✅ Seeded 4 WhatsApp message bundles");
}
