// src/services/razorpay/razorpay-service.ts

import crypto from "node:crypto";

/**
 * RAZORPAY SERVICE — the ONLY file in the codebase that talks to Razorpay's
 * HTTP API. Every payment module (setup-fee, access-plans, bundles, the
 * webhook handler) goes through this service. This keeps the integration
 * testable, keeps API-version quirks in one place, and means swapping SDKs
 * or API versions later only touches this file.
 *
 * Razorpay's official Node SDK is intentionally NOT used here — it's a thin
 * wrapper around the same REST endpoints, and avoiding it keeps this
 * Cloudflare-Workers-friendly (no Node-specific dependencies beyond the
 * built-in `crypto` module, which Workers supports via `node:crypto`
 * compat). All calls use plain `fetch` against `https://api.razorpay.com/v1`.
 *
 * Auth: Basic Auth with `key_id:key_secret` base64-encoded, exactly as
 * Razorpay's docs specify for every endpoint below.
 */

const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Minimal response shapes we actually read. Razorpay returns many more
// fields than these — we only type what the codebase consumes, to avoid
// false confidence about fields we never validated.
// ─────────────────────────────────────────────────────────────────────────

export interface RazorpayOrderResponse {
  id: string; // "order_xxxxx"
  amount: number; // paise
  currency: string;
  status: string; // "created" | "attempted" | "paid"
  receipt?: string;
  notes: Record<string, string>;
}

export interface RazorpayCustomerResponse {
  id: string; // "cust_xxxxx"
  name: string;
  email: string;
  contact: string;
}

export interface RazorpayPlanResponse {
  id: string; // "plan_xxxxx"
  period: string;
  interval: number;
  item: { amount: number; currency: string; name: string };
}

export interface RazorpaySubscriptionResponse {
  id: string; // "sub_xxxxx"
  plan_id: string;
  customer_id: string | null;
  status: string;
  current_start: number | null; // unix seconds
  current_end: number | null;
  charge_at: number | null;
  total_count: number;
  paid_count: number;
  short_url?: string;
}

export interface RazorpayPaymentResponse {
  id: string; // "pay_xxxxx"
  order_id: string | null;
  status: string;
  method: string;
  amount: number;
  currency: string;
}

// ─────────────────────────────────────────────────────────────────────────

export class RazorpayService {
  private readonly authHeader: string;

  constructor(private readonly creds: RazorpayCredentials) {
    this.authHeader =
      "Basic " +
      Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  }

  /** Internal fetch wrapper — consistent error surfacing across all calls. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(`${RAZORPAY_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (json as any)?.error?.description ||
        `Razorpay API error (${response.status})`;
      throw new Error(message);
    }

    return json as T;
  }

  // ── ORDERS API (manual one-time rail) ─────────────────────────────────

  /**
   * Creates a Razorpay Order. Used for: setup fee, message bundles, and
   * access plans when the school pays manually (default, non-autopay path).
   *
   * @param amountPaise  EXACT amount to charge, in paise. Caller MUST source
   *                      this from a server-side finalAmountPaise field —
   *                      never from client input.
   * @param notes         Routing metadata attached to the order; returned
   *                       verbatim in every webhook payload for this order,
   *                       so the webhook handler can route without a DB
   *                       lookup. Razorpay allows max 15 string key-value
   *                       pairs.
   * @param receipt        Optional internal receipt/reference string,
   *                        shown on the Razorpay dashboard for reconciliation.
   */
  async createOrder(params: {
    amountPaise: number;
    currency?: string;
    notes: Record<string, string>;
    receipt?: string;
  }): Promise<RazorpayOrderResponse> {
    return this.request<RazorpayOrderResponse>("POST", "/orders", {
      amount: params.amountPaise,
      currency: params.currency ?? "INR",
      notes: params.notes,
      receipt: params.receipt,
      payment_capture: 1, // auto-capture — we never want manual capture for these flows
    });
  }

  async fetchOrder(orderId: string): Promise<RazorpayOrderResponse> {
    return this.request<RazorpayOrderResponse>("GET", `/orders/${orderId}`);
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentResponse> {
    return this.request<RazorpayPaymentResponse>(
      "GET",
      `/payments/${paymentId}`
    );
  }

  /**
   * Verifies the signature returned by Checkout for an ORDER payment.
   * Formula per Razorpay docs: hmac_sha256(order_id + "|" + payment_id, secret)
   */
  verifyOrderSignature(params: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): boolean {
    const expected = crypto
      .createHmac("sha256", this.creds.keySecret)
      .update(`${params.razorpayOrderId}|${params.razorpayPaymentId}`)
      .digest("hex");
    return timingSafeEqualHex(expected, params.razorpaySignature);
  }

  // ── CUSTOMERS API (only needed for Autopay rail) ──────────────────────

  /**
   * Creates a Razorpay Customer. ONLY called the first time a school opts
   * into Autopay — manual-order-only schools never get a Customer object.
   * Razorpay also de-dupes customers with the same email+contact, but we
   * cache the resulting id in school_razorpay_customers regardless so we
   * never make this call more than once per school.
   */
  async createCustomer(params: {
    name: string;
    email: string;
    contact: string;
  }): Promise<RazorpayCustomerResponse> {
    return this.request<RazorpayCustomerResponse>("POST", "/customers", {
      name: params.name,
      email: params.email,
      contact: params.contact,
      fail_existing: "0", // if a customer with this email/contact exists, return it instead of erroring
    });
  }

  // ── PLANS API (Autopay rail only — lazy, cached, immutable once created) ─

  /**
   * Creates a Razorpay Plan. Plans are IMMUTABLE once created — this is
   * only ever called when access_plans.razorpayPlanId is NULL (either
   * never created, or cleared after a discount change). The caller is
   * responsible for persisting the returned id back onto access_plans.
   */
  async createPlan(params: {
    period: "monthly" | "yearly";
    interval: number; // 1 = every period; e.g. monthly + interval 1 = every month
    amountPaise: number;
    name: string;
    description?: string;
  }): Promise<RazorpayPlanResponse> {
    return this.request<RazorpayPlanResponse>("POST", "/plans", {
      period: params.period,
      interval: params.interval,
      item: {
        name: params.name,
        amount: params.amountPaise,
        currency: "INR",
        description: params.description ?? "",
      },
    });
  }

  // ── SUBSCRIPTIONS API (Autopay rail only) ──────────────────────────────

  /**
   * Creates a Razorpay Subscription against an existing Plan + Customer.
   * `total_count: 0` would be invalid (Razorpay requires a positive count),
   * so callers must pass a large-but-finite count (e.g. 120 cycles = 10
   * years for monthly) to emulate an "indefinite" subscription — the
   * school can always cancel earlier via the cancel endpoint.
   *
   * `notify_info` / `notes` carry the same routing metadata pattern as
   * Orders — returned verbatim in subscription.* webhooks.
   */
  async createSubscription(params: {
    planId: string;
    customerId: string;
    totalCount: number;
    notes: Record<string, string>;
  }): Promise<RazorpaySubscriptionResponse> {
    return this.request<RazorpaySubscriptionResponse>(
      "POST",
      "/subscriptions",
      {
        plan_id: params.planId,
        customer_id: params.customerId,
        total_count: params.totalCount,
        customer_notify: 1,
        notes: params.notes,
      }
    );
  }

  async fetchSubscription(
    subscriptionId: string
  ): Promise<RazorpaySubscriptionResponse> {
    return this.request<RazorpaySubscriptionResponse>(
      "GET",
      `/subscriptions/${subscriptionId}`
    );
  }

  /**
   * Cancels a Subscription. `cancelAtCycleEnd: true` lets the current
   * already-paid-for cycle finish naturally (no refund, access continues
   * until period end) rather than cancelling immediately — usually the
   * better default for a school clicking "turn off auto-renew".
   */
  async cancelSubscription(
    subscriptionId: string,
    cancelAtCycleEnd: boolean
  ): Promise<RazorpaySubscriptionResponse> {
    return this.request<RazorpaySubscriptionResponse>(
      "POST",
      `/subscriptions/${subscriptionId}/cancel`,
      { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 }
    );
  }

  /**
   * Verifies the signature returned by Checkout for a SUBSCRIPTION
   * authorisation payment. Formula per Razorpay docs:
   * hmac_sha256(payment_id + "|" + subscription_id, secret)
   * NOTE the argument order differs from verifyOrderSignature — Razorpay
   * specifies payment_id FIRST here, order_id FIRST for orders. Easy to
   * get backwards; do not "simplify" these into one shared function.
   */
  verifySubscriptionSignature(params: {
    razorpaySubscriptionId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): boolean {
    const expected = crypto
      .createHmac("sha256", this.creds.keySecret)
      .update(`${params.razorpayPaymentId}|${params.razorpaySubscriptionId}`)
      .digest("hex");
    return timingSafeEqualHex(expected, params.razorpaySignature);
  }

  // ── WEBHOOK SIGNATURE VERIFICATION ──────────────────────────────────────

  /**
   * Verifies the `X-Razorpay-Signature` header on an incoming webhook.
   * CRITICAL: `rawBody` MUST be the exact raw request body bytes/string as
   * received — never a re-serialized `JSON.stringify(parsedBody)`, since
   * key ordering or whitespace differences will silently break the
   * signature match. The Hono webhook route must read the raw body BEFORE
   * calling `c.req.json()`.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = crypto
      .createHmac("sha256", this.creds.webhookSecret)
      .update(rawBody)
      .digest("hex");
    return timingSafeEqualHex(expected, signature);
  }
}

/** Constant-time hex string comparison to avoid timing attacks on signature checks. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Factory — reads credentials from env bindings, used by every module. */
export function getRazorpayService(env: {
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
}): RazorpayService {
  return new RazorpayService({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });
}
