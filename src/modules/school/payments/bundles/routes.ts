// src/modules/school/payments/bundles/routes.ts

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
  initiateBundlePurchase,
  verifyBundlePurchase,
  getAvailableBundles,
  getSchoolBundleHistory,
} from "./services";

const bundlesRouter = new Hono<SchoolEnv>();

bundlesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

async function resolveSchool(
  c: any
): Promise<{ id: number; uniqueCode: string }> {
  const schoolCode = c.get("schoolCode") as string;
  const db = getCommonDB(c.env);
  const school = await db
    .select({ id: schoolsSchema.id, uniqueCode: schoolsSchema.uniqueCode })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.uniqueCode, schoolCode))
    .get();
  if (!school) throw new Error("School not found");
  return school;
}

// ==================== LIST AVAILABLE BUNDLES ====================
// GET /payments/bundles?channel=WHATSAPP
bundlesRouter.get("/", async (c) => {
  try {
    const channel = c.req.query("channel") as
      | "WHATSAPP"
      | "EMAIL"
      | "SMS"
      | undefined;
    if (!channel || !["WHATSAPP", "EMAIL", "SMS"].includes(channel)) {
      return c.json(
        {
          success: false,
          error: "channel query param required: WHATSAPP | EMAIL | SMS",
        },
        400
      );
    }
    const bundles = await getAvailableBundles(c.env as any, channel);
    return c.json({ success: true, bundles });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET BUNDLE PURCHASE HISTORY ====================
// GET /payments/bundles/history?channel=WHATSAPP
bundlesRouter.get("/history", async (c) => {
  try {
    const school = await resolveSchool(c);
    const channel = c.req.query("channel") as
      | "WHATSAPP"
      | "EMAIL"
      | "SMS"
      | undefined;
    const history = await getSchoolBundleHistory(
      c.env as any,
      school.id,
      channel
    );
    return c.json({ success: true, history });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== INITIATE BUNDLE PURCHASE ====================
// POST /payments/bundles/initiate
bundlesRouter.post(
  "/initiate",
  requirePermission("billing.manage"),
  zValidator("json", z.object({ bundleId: z.number().int().positive() })),
  async (c) => {
    try {
      const { bundleId } = c.req.valid("json");
      const school = await resolveSchool(c);
      const result = await initiateBundlePurchase(
        c.env as any,
        school.id,
        bundleId
      );
      return c.json({ success: true, ...result });   // ← fixed
    } catch (error: any) {
      return c.json(
        {
          success: false,
          error: error.message || "Failed to initiate purchase",
        },
        400
      );
    }
  }
);

// ==================== VERIFY BUNDLE PURCHASE ====================
// POST /payments/bundles/verify
bundlesRouter.post(
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
      const school = await resolveSchool(c);
      const result = await verifyBundlePurchase(
        c.env as any,
        school.uniqueCode,
        {
          ...data,
          schoolId: school.id,
        }
      );
      return c.json(result);
    } catch (error: any) {
      return c.json(
        { success: false, error: error.message || "Verification failed" },
        400
      );
    }
  }
);

export default bundlesRouter;
