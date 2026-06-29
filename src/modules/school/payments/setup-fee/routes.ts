// src/modules/school/payments/setup-fee/routes.ts
//
// These routes are called DURING onboarding — before the school has a working
// login. So they are PUBLIC (no JWT middleware). The schoolId is resolved from
// the schoolCode path param, which came from the invitation flow.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { Env } from "../../../../types/common-types";
import { getCommonDB } from "../../../../db";
import { schoolsSchema } from "../../../../db/schemas/super";
import { initiateSetupFeePayment, verifySetupFeePayment } from "./services";

const setupFeeRouter = new Hono<Env>();

// ==================== INITIATE SETUP FEE PAYMENT ====================
// POST /payments/setup-fee/initiate
// Body: { schoolCode: string }
// Returns: { razorpayOrderId, amountPaise, currency, keyId, platformPaymentId }

setupFeeRouter.post(
  "/initiate",
  zValidator(
    "json",
    z.object({
      schoolCode: z
        .string()
        .min(3)
        .transform((v) => v.toUpperCase()),
    })
  ),
  async (c) => {
    try {
      const { schoolCode } = c.req.valid("json");
      const db = getCommonDB(c.env);

      const school = await db
        .select({ id: schoolsSchema.id })
        .from(schoolsSchema)
        .where(eq(schoolsSchema.uniqueCode, schoolCode))
        .get();

      if (!school) {
        return c.json({ success: false, error: "School not found" }, 404);
      }

      const result = await initiateSetupFeePayment(c.env, school.id);
      return c.json(result);
    } catch (error: any) {
      console.error("Setup fee initiate error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to initiate payment",
        },
        400
      );
    }
  }
);

// ==================== VERIFY SETUP FEE PAYMENT ====================
// POST /payments/setup-fee/verify
// Body: { schoolCode, razorpayOrderId, razorpayPaymentId, razorpaySignature }

setupFeeRouter.post(
  "/verify",
  zValidator(
    "json",
    z.object({
      schoolCode: z
        .string()
        .min(3)
        .transform((v) => v.toUpperCase()),
      razorpayOrderId: z.string(),
      razorpayPaymentId: z.string(),
      razorpaySignature: z.string(),
    })
  ),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const db = getCommonDB(c.env);

      const school = await db
        .select({ id: schoolsSchema.id })
        .from(schoolsSchema)
        .where(eq(schoolsSchema.uniqueCode, data.schoolCode))
        .get();

      if (!school) {
        return c.json({ success: false, error: "School not found" }, 404);
      }

      const result = await verifySetupFeePayment(c.env, {
        schoolId: school.id,
        razorpayOrderId: data.razorpayOrderId,
        razorpayPaymentId: data.razorpayPaymentId,
        razorpaySignature: data.razorpaySignature,
      });

      return c.json(result);
    } catch (error: any) {
      console.error("Setup fee verify error:", error);
      return c.json(
        { success: false, error: error.message || "Verification failed" },
        400
      );
    }
  }
);

export default setupFeeRouter;
