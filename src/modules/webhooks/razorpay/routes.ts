// src/modules/webhooks/razorpay/routes.ts
//
// CRITICAL: This route MUST read the raw request body as text BEFORE calling
// any JSON parsing helper. The webhook signature verification requires the
// exact raw bytes. Re-serialising parsed JSON will silently break signatures
// if key ordering or whitespace differs.

import { Hono } from "hono";
import { Env } from "../../../types/common-types";
import { handleRazorpayWebhook } from "./handler";

const razorpayWebhookRouter = new Hono<Env>();

// POST /webhooks/razorpay
// No auth middleware — Razorpay doesn't send a JWT. Authenticity is proven
// by the X-Razorpay-Signature HMAC header, verified inside the handler.
razorpayWebhookRouter.post("/", async (c) => {
  // Read raw body as text — MUST happen before any c.req.json() call.
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature") ?? "";

  if (!signature) {
    return c.json({ error: "Missing X-Razorpay-Signature header" }, 400);
  }

  const { status, body } = await handleRazorpayWebhook(
    c.env,
    rawBody,
    signature
  );
  return c.json(body, status as any);
});

export default razorpayWebhookRouter;
