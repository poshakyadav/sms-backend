// src/modules/school/payments/access/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolEnv } from "../../../../types/common-types";
import { getCommonDB } from "../../../../db";
import { schoolsSchema } from "../../../../db/schemas/super";
import {
  initiateAccessOrder,
  verifyAccessOrder,
  initiateAutopaySubscription,
  verifyAutopaySubscriptionAuth,
  cancelAutopaySubscription,
  getAccessStatus,
} from "./services";
import { getAllAccessPlans } from "../../../super/access-plans/services";

const accessPaymentRouter = new Hono<SchoolEnv>();

accessPaymentRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// Helper: resolve schoolId from JWT schoolCode
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

// ==================== GET AVAILABLE PLANS ====================
// GET /payments/access/plans
// Returns both plans with pricing for the billing/pricing screen
accessPaymentRouter.get("/plans", async (c) => {
  try {
    const plans = await getAllAccessPlans(c.env as any);
    console.log("plans", plans);
    return c.json({ success: true, plans });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET ACCESS STATUS ====================
// GET /payments/access/status
accessPaymentRouter.get("/status", async (c) => {
  try {
    const schoolId = await resolveSchoolId(c);
    const status = await getAccessStatus(c.env as any, schoolId);
    return c.json({ success: true, ...status });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== INITIATE MANUAL ORDER ====================
// POST /payments/access/initiate
accessPaymentRouter.post(
  "/initiate",
  requirePermission("billing.manage"),
  zValidator("json", z.object({ planType: z.enum(["MONTHLY", "YEARLY"]) })),
  async (c) => {
    try {
      const { planType } = c.req.valid("json");
      const schoolId = await resolveSchoolId(c);
      const result = await initiateAccessOrder(
        c.env as any,
        schoolId,
        planType
      );
      return c.json({ success: true, ...result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// ==================== VERIFY MANUAL ORDER ====================
// POST /payments/access/verify
accessPaymentRouter.post(
  "/verify",
  requirePermission("billing.manage"),
  zValidator(
    "json",
    z.object({
      razorpayOrderId: z.string(),
      razorpayPaymentId: z.string(),
      razorpaySignature: z.string(),
    })
  ),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolId = await resolveSchoolId(c);
      const result = await verifyAccessOrder(c.env as any, {
        ...data,
        schoolId,
      });
      return c.json(result);
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// ==================== INITIATE AUTOPAY SUBSCRIPTION ====================
// POST /payments/access/autopay/initiate
accessPaymentRouter.post(
  "/autopay/initiate",
  requirePermission("billing.manage"),
  zValidator("json", z.object({ planType: z.enum(["MONTHLY", "YEARLY"]) })),
  async (c) => {
    try {
      const { planType } = c.req.valid("json");
      const schoolId = await resolveSchoolId(c);
      const result = await initiateAutopaySubscription(
        c.env as any,
        schoolId,
        planType
      );
      return c.json({ success: true, ...result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// ==================== VERIFY AUTOPAY AUTHORISATION ====================
// POST /payments/access/autopay/verify
accessPaymentRouter.post(
  "/autopay/verify",
  requirePermission("billing.manage"),
  zValidator(
    "json",
    z.object({
      razorpaySubscriptionId: z.string(),
      razorpayPaymentId: z.string(),
      razorpaySignature: z.string(),
    })
  ),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolId = await resolveSchoolId(c);
      const result = await verifyAutopaySubscriptionAuth(c.env as any, {
        ...data,
        schoolId,
      });
      return c.json(result);
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// ==================== CANCEL AUTOPAY ====================
// POST /payments/access/autopay/cancel
accessPaymentRouter.post(
  "/autopay/cancel",
  requirePermission("billing.manage"),
  zValidator("json", z.object({ cancelAtCycleEnd: z.boolean().default(true) })),
  async (c) => {
    try {
      const { cancelAtCycleEnd } = c.req.valid("json");
      const schoolId = await resolveSchoolId(c);
      const result = await cancelAutopaySubscription(
        c.env as any,
        schoolId,
        cancelAtCycleEnd
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

export default accessPaymentRouter;
