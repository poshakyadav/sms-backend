// src/modules/webhooks/whatsapp/routes.ts
//
// Two endpoints:
//   GET  /webhooks/whatsapp  — Meta's one-time webhook verification
//   POST /webhooks/whatsapp  — Live webhook events (messages + status updates)
//
// ── SECURITY ───────────────────────────────────────────────────────────────
// Meta does NOT send a JWT or HMAC signature on WhatsApp Cloud API webhooks
// (unlike Razorpay). Authentication is done during verification via the
// hub.verify_token check. After that, requests come from Meta's known IP
// ranges — we trust them based on the verified subscription.
//
// For extra security, you can compare payload.entry[*].id === WABA_ID
// inside the handler to reject spoofed requests from other WA accounts.
// ───────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { Env } from "../../../types/common-types";
import { WhatsappService } from "../../../services/whatsapp/whatsapp-service";
import { handleWhatsappWebhook } from "./handler";

const whatsappWebhookRouter = new Hono<Env>();

// ── GET /webhooks/whatsapp — Webhook verification (one-time setup) ─────────
// Meta sends this when you first register the webhook URL in the App Dashboard.
// We must echo back hub.challenge if hub.verify_token matches our secret.
// After this, Meta starts sending real events to the POST endpoint.
whatsappWebhookRouter.get("/", (c) => {
  const mode = c.req.query("hub.mode") ?? "";
  const token = c.req.query("hub.verify_token") ?? "";
  const challenge = c.req.query("hub.challenge") ?? "";

  const expectedToken = (c.env as any).WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "";

  if (!expectedToken) {
    console.error(
      "[WA Webhook] WHATSAPP_WEBHOOK_VERIFY_TOKEN env var not set!"
    );
    return c.text("Configuration error", 500);
  }

  const isValid = WhatsappService.verifyWebhook(mode, token, expectedToken);

  if (isValid) {
    console.log("[WA Webhook] Verification successful");
    // Must return the challenge as plain text with 200 — NOT JSON
    return c.text(challenge, 200);
  }

  console.warn(
    `[WA Webhook] Verification failed — token mismatch (got: "${token}")`
  );
  return c.text("Forbidden", 403);
});

// ── POST /webhooks/whatsapp — Live events ─────────────────────────────────
// Meta posts events here. Always return 200 quickly, then process async.
// Non-200 responses cause Meta to retry with exponential backoff.
whatsappWebhookRouter.post("/", async (c) => {
  // Read raw body as text — do this before any other processing
  const rawBody = await c.req.text();

  // Optional: verify the WABA ID matches ours
  const ourWabaId = (c.env as any).WHATSAPP_WABA_ID ?? "";
  if (ourWabaId && rawBody.includes('"object"')) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed.object !== "whatsapp_business_account") {
        return c.json({ received: true, action: "ignored" }, 200);
      }
      // Check at least one entry matches our WABA
      const hasOurWaba = (parsed.entry ?? []).some(
        (e: any) => !ourWabaId || e.id === ourWabaId
      );
      if (!hasOurWaba) {
        console.warn("[WA Webhook] Entry WABA ID mismatch — ignoring");
        return c.json({ received: true, action: "waba_mismatch" }, 200);
      }
    } catch {
      // JSON parse already validates format; proceed
    }
  }

  // Process asynchronously so we return 200 immediately to Meta
  const processPromise = handleWhatsappWebhook(c.env as any, rawBody);

  // Cloudflare Workers: use waitUntil to continue processing after response
  if ((c.executionCtx as any)?.waitUntil) {
    (c.executionCtx as any).waitUntil(
      processPromise.catch((err) =>
        console.error("[WA Webhook] Async processing error:", err)
      )
    );
    return c.json({ received: true }, 200);
  }

  // Fallback: await (non-Workers environments like local dev)
  try {
    const result = await processPromise;
    return c.json(result.body, result.status as any);
  } catch (err: any) {
    console.error("[WA Webhook] Processing error:", err);
    return c.json({ received: true, error: err.message }, 200); // Still 200
  }
});

export default whatsappWebhookRouter;
