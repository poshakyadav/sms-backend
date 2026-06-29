// src/modules/school/billing/routes.ts
//
// School-facing read endpoints for the billing screen:
//   - payment history
//   - WhatsApp balance
//   - current access status
// These routes must remain accessible even when access has LAPSED
// (so the school can see what happened and renew). Do NOT apply
// requireActiveAccess middleware here.

import { Hono } from "hono";
import { eq, desc, sql, and } from "drizzle-orm";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { getSchoolDB } from "../../../db/school-client";
import {
  platformPaymentsSchema,
  schoolsSchema,
  schoolBundlePurchasesSchema,
  messageBundlesSchema,
  schoolAccessPeriodsSchema,
  schoolAutopaySubscriptionsSchema,
} from "../../../db/schemas/super";
import {
  whatsappBalanceSchema,
  whatsappBundleCreditsSchema,
} from "../../../db/schemas/school";

const billingRouter = new Hono<SchoolEnv>();

billingRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

async function resolveSchoolId(c: any): Promise<number> {
  const schoolCode = c.get("schoolCode") as string;
  const db = getCommonDB(c.env);
  const school = await db
    .select({ id: schoolsSchema.id })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.uniqueCode, schoolCode))
    .get();
  if (!school) throw new Error("School not found");
  return school.id;
}

// ==================== PAYMENT HISTORY ====================
// GET /billing/history?limit=20&offset=0&paymentType=&status=
billingRouter.get("/history", async (c) => {
  try {
    const schoolId = await resolveSchoolId(c);
    const db = getCommonDB(c.env);

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const paymentType = c.req.query("paymentType");
    const status = c.req.query("status");

    const conditions = [eq(platformPaymentsSchema.schoolId, schoolId)];
    if (paymentType) {
      conditions.push(
        eq(platformPaymentsSchema.paymentType, paymentType as any)
      );
    }
    if (status) {
      conditions.push(eq(platformPaymentsSchema.status, status as any));
    }

    const payments = await db
      .select({
        id: platformPaymentsSchema.id,
        paymentType: platformPaymentsSchema.paymentType,
        source: platformPaymentsSchema.source,
        amountPaise: platformPaymentsSchema.amountPaise,
        currency: platformPaymentsSchema.currency,
        status: platformPaymentsSchema.status,
        method: platformPaymentsSchema.method,
        description: platformPaymentsSchema.description,
        razorpayPaymentId: platformPaymentsSchema.razorpayPaymentId,
        capturedAt: platformPaymentsSchema.capturedAt,
        createdAt: platformPaymentsSchema.createdAt,
      })
      .from(platformPaymentsSchema)
      .where(and(...conditions))
      .orderBy(desc(platformPaymentsSchema.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return c.json({ success: true, payments, limit, offset });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== ACCESS PERIOD HISTORY ====================
// GET /billing/access-history
// All school_access_periods rows — useful for "when did you pay, until when"
billingRouter.get("/access-history", async (c) => {
  try {
    const schoolId = await resolveSchoolId(c);
    const db = getCommonDB(c.env);

    const periods = await db
      .select({
        id: schoolAccessPeriodsSchema.id,
        planType: schoolAccessPeriodsSchema.planType,
        source: schoolAccessPeriodsSchema.source,
        startsAt: schoolAccessPeriodsSchema.startsAt,
        expiresAt: schoolAccessPeriodsSchema.expiresAt,
        createdAt: schoolAccessPeriodsSchema.createdAt,
        notes: schoolAccessPeriodsSchema.notes,
      })
      .from(schoolAccessPeriodsSchema)
      .where(eq(schoolAccessPeriodsSchema.schoolId, schoolId))
      .orderBy(desc(schoolAccessPeriodsSchema.createdAt))
      .all();

    return c.json({ success: true, periods });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== CURRENT ACCESS STATUS ====================
// GET /billing/access-status
// Returns hasAccess, expiresAt, daysRemaining, and autopay info
billingRouter.get("/access-status", async (c) => {
  try {
    const schoolId = await resolveSchoolId(c);
    const { getAccessStatus } = await import("../payments/access/services");
    const status = await getAccessStatus(c.env as any, schoolId);
    return c.json({ success: true, ...status });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== WHATSAPP BALANCE ====================
// GET /billing/balance/whatsapp
billingRouter.get("/balance/whatsapp", async (c) => {
  try {
    const schoolCode = c.get("schoolCode") as string;

    const schoolDb = await getSchoolDB(c.env, schoolCode);

    const [balance, activeBundles] = await Promise.all([
      schoolDb
        .select()
        .from(whatsappBalanceSchema)
        .where(eq(whatsappBalanceSchema.id, 1))
        .get(),
      schoolDb
        .select()
        .from(whatsappBundleCreditsSchema)
        .where(eq(whatsappBundleCreditsSchema.isExpired, false))
        .orderBy(whatsappBundleCreditsSchema.expiresAt)
        .all(),
    ]);

    return c.json({
      success: true,
      balance: balance ?? {
        totalCreditsEverPurchased: 0,
        creditsUsed: 0,
        creditsRemaining: 0,
        lastPurchaseAt: null,
      },
      activeBundles,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== BUNDLE PURCHASE HISTORY ====================
// GET /billing/bundles?channel=WHATSAPP
billingRouter.get("/bundles", async (c) => {
  try {
    const schoolId = await resolveSchoolId(c);
    const db = getCommonDB(c.env);
    const channel = c.req.query("channel") as string | undefined;

    const conditions = [eq(schoolBundlePurchasesSchema.schoolId, schoolId)];
    if (channel) {
      conditions.push(eq(schoolBundlePurchasesSchema.channel, channel as any));
    }

    const history = await db
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
      .orderBy(desc(schoolBundlePurchasesSchema.createdAt))
      .all();

    return c.json({ success: true, history });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default billingRouter;
