// src/modules/super/payment-config/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getPaymentConfig, updatePaymentConfig } from "./services";

const paymentConfigRouter = new Hono<Env>();

paymentConfigRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ==================== GET PAYMENT CONFIG ====================
paymentConfigRouter.get(
  "/",
  requireSuperPermission("payments.config"),
  async (c) => {
    try {
      const config = await getPaymentConfig(c.env);
      return c.json({ success: true, config });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== UPDATE PAYMENT CONFIG ====================
const updateSchema = z.object({
  upiId: z.string().optional(),
  qrCodeUrl: z.string().url().optional().or(z.literal("")),
  setupFeeAmount: z.number().int().min(0).optional(),
  setupFeeDiscountPaise: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  feeDescription: z.string().optional(),
  isFeeEnabled: z.boolean().optional(),
});

paymentConfigRouter.put(
  "/",
  requireSuperPermission("payments.config"),
  zValidator("json", updateSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const config = await updatePaymentConfig(c.env, data);
      return c.json({
        success: true,
        message: "Payment configuration updated successfully",
        config,
      });
    } catch (error: any) {
      return c.json(
        { success: false, error: error.message || "Update failed" },
        400
      );
    }
  }
);

export default paymentConfigRouter;
