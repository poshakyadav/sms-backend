// src/modules/super/payment-config/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { getPaymentConfig, upsertPaymentConfig } from "./services";

const paymentConfigRouter = new Hono<Env>();


// ── PUBLIC: GET /payment-config ───────────────────────────────────────────────
// Must be PUBLIC (no auth) so the school payment page can fetch fee/UPI details
// without a token. The data is non-sensitive (UPI ID, QR URL, fee amount).
// This route is declared BEFORE the auth middleware so it bypasses it.
paymentConfigRouter.get("/", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const config = await getPaymentConfig(db);
    return c.json({ success: true, config });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


paymentConfigRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// PUT /payment-config — upsert (super admin only)
paymentConfigRouter.put(
  "/",
  requireSuperPermission("schools.manage"),
  zValidator(
    "json",
    z.object({
      upiId: z.string().min(3).max(100),
      qrCodeUrl: z.string().url().optional().or(z.literal("")),
      setupFeeAmount: z.number().int().min(0), // paise
      currency: z.string().default("INR"),
      feeDescription: z.string().min(5).max(500),
      isFeeEnabled: z.boolean(),
    })
  ),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const data = c.req.valid("json");
      const config = await upsertPaymentConfig(db, data);
      return c.json({ success: true, config });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

export default paymentConfigRouter;
