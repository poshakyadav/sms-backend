import { Bindings } from "hono/types";

export type SuperUserContext = {
  id: number;
  name: string;
  permissions: string[]; // SuperPermissionSlugWithWildcard[] at runtime
  tokenVersion: number;
};

export type SchoolUserContext = {
  id: number;
  name: string;
  email: string;
  schoolCode: string;
  permissions: string[]; // ← Full permissions from JWT
  tokenVersion: number; // ← For instant invalidation
  /** Role name embedded in JWT by generateSchoolTokens (e.g. "TEACHER", "STUDENT_PARENT") */
  role?: string;
};

export type Env = {
  Bindings: Bindings & {
    // Add any KV namespaces, Durable Objects, or other bindings here

    // ── CORS ─────────────────────────────────────────────────────────────────
    // For CORS configuration (if needed in code, otherwise set in middleware)
    FRONTEND_ORIGIN: string;

    // ── Turso databases ───────────────────────────────────────────────────────
    COMMON_TURSO_DATABASE_EMAIL: string;
    COMMON_TURSO_DATABASE_URL: string;
    COMMON_TURSO_AUTH_TOKEN: string;
    SCHOOL_TURSO_DATABASE_URL: string;
    SCHOOL_TURSO_AUTH_TOKEN: string;

    // Test Turso Database URL and Auth Token
    TEST_TURSO_DATABASE_URL: string;
    TEST_TURSO_AUTH_TOKEN: string;

    // ── Core ─────────────────────────────────────────────────────────────────
    APP_URL: string;
    JWT_SECRET: string;

    // ── Email (Brevo) ─────────────────────────────────────────────────────────
    BREVO_API_KEY: string;
    BREVO_SENDER_EMAIL: string;
    BREVO_SENDER_NAME: string;

    // ── Razorpay ──────────────────────────────────────────────────────────────
    // RAZORPAY_KEY_ID is the PUBLIC key — safe to send to the browser for Checkout.
    // RAZORPAY_KEY_SECRET is the PRIVATE key — server-side only, never expose.
    // RAZORPAY_WEBHOOK_SECRET is used to verify the HMAC signature on incoming
    //   webhook payloads from Razorpay's servers.
    //
    // How to set these:
    //   wrangler secret put RAZORPAY_KEY_ID
    //   wrangler secret put RAZORPAY_KEY_SECRET
    //   wrangler secret put RAZORPAY_WEBHOOK_SECRET
    //
    // For local dev, add to .dev.vars (never commit):
    //   RAZORPAY_KEY_ID = "rzp_test_..."
    //   RAZORPAY_KEY_SECRET = "..."
    //   RAZORPAY_WEBHOOK_SECRET = "..."
    RAZORPAY_KEY_ID: string;
    RAZORPAY_KEY_SECRET: string;
    RAZORPAY_WEBHOOK_SECRET: string;

    // ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────
    //
    // WHATSAPP_ACCESS_TOKEN: Permanent System User token from Meta Business Manager.
    //   Generate: Business Settings → System Users → Generate Token (never expires).
    //   Permissions needed: whatsapp_business_management + whatsapp_business_messaging
    //
    // WHATSAPP_PHONE_NUMBER_ID: From App Dashboard → WhatsApp → API Setup.
    //   Format: "111712345678901" (numeric string, ~15 digits).
    //
    // WHATSAPP_WABA_ID: WhatsApp Business Account ID.
    //   Format: "145022345678901" (numeric string, ~15 digits).
    //
    // WHATSAPP_WEBHOOK_VERIFY_TOKEN: A secret YOU choose — entered in both
    //   this env var AND in App Dashboard → Webhooks → Verify Token field.
    //   Meta sends it back during webhook verification to confirm the URL is ours.
    //   Use any random string, e.g. "sms-wa-verify-2026-xyz123"
    //
    // WHATSAPP_APP_ID: Your Meta App ID (numeric string).
    //   Used for WABA subscription and management API calls.
    //
    // Local dev (.dev.vars — never commit):
    //   WHATSAPP_ACCESS_TOKEN = "EAAOkjVA5..."
    //   WHATSAPP_PHONE_NUMBER_ID = "1117..."
    //   WHATSAPP_WABA_ID = "14502..."
    //   WHATSAPP_WEBHOOK_VERIFY_TOKEN = "sms-wa-verify-2026-xyz"
    //   WHATSAPP_APP_ID = "10..."
    //
    // Production (wrangler secret put):
    //   wrangler secret put WHATSAPP_ACCESS_TOKEN
    //   wrangler secret put WHATSAPP_PHONE_NUMBER_ID
    //   wrangler secret put WHATSAPP_WABA_ID
    //   wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN
    //   wrangler secret put WHATSAPP_APP_ID
    WHATSAPP_ACCESS_TOKEN: string;
    WHATSAPP_PHONE_NUMBER_ID: string;
    WHATSAPP_WABA_ID: string;
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: string;
    WHATSAPP_APP_ID: string;

    // ── Cloudflare R2 (Feed Images) ─────────────────────────────────────────
    //
    // R2_ACCOUNT_ID: Your Cloudflare account ID (dashboard → right sidebar).
    //
    // R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY: R2 API token credentials.
    //   Generate: Cloudflare Dashboard → R2 → Manage R2 API Tokens →
    //   Create API Token → permissions: "Object Read & Write" scoped to
    //   the school-feed-images bucket only (least privilege).
    //
    // R2_FEED_BUCKET_NAME: e.g. "school-feed-images"
    //
    // R2_FEED_PUBLIC_URL: the public base URL for the bucket — either the
    //   default r2.dev subdomain (e.g. "https://pub-xxxx.r2.dev") or a
    //   custom domain you've mapped to the bucket. No trailing slash.
    //
    // Local dev (.dev.vars — never commit):
    //   R2_ACCOUNT_ID = "..."
    //   R2_ACCESS_KEY_ID = "..."
    //   R2_SECRET_ACCESS_KEY = "..."
    //   R2_FEED_BUCKET_NAME = "school-feed-images"
    //   R2_FEED_PUBLIC_URL = "https://pub-xxxx.r2.dev"
    //
    // Production (wrangler secret put):
    //   wrangler secret put R2_ACCOUNT_ID
    //   wrangler secret put R2_ACCESS_KEY_ID
    //   wrangler secret put R2_SECRET_ACCESS_KEY
    //   wrangler secret put R2_FEED_BUCKET_NAME
    //   wrangler secret put R2_FEED_PUBLIC_URL
    R2_ACCOUNT_ID: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_FEED_BUCKET_NAME: string; // school-feed-images
    R2_FEED_PUBLIC_URL: string;

    // Separate bucket from R2_FEED_BUCKET_NAME — profile photos are a distinct
    // media type (one-per-user, replace-in-place) vs feed images (many-per-post,
    // append-only). Same R2 account/credentials as above; only bucket + public
    // URL differ.
    //
    // R2_AVATARS_BUCKET_NAME: e.g. "school-user-avatars"
    //
    // R2_AVATARS_PUBLIC_URL: the public base URL for the bucket — either the
    //   default r2.dev subdomain or a custom domain mapped to the bucket.
    //   No trailing slash.
    //
    // Local dev (.dev.vars — never commit):
    //   R2_AVATARS_BUCKET_NAME = "school-user-avatars"
    //   R2_AVATARS_PUBLIC_URL = "https://pub-yyyy.r2.dev"
    //
    // Production (wrangler secret put):
    //   wrangler secret put R2_AVATARS_BUCKET_NAME
    //   wrangler secret put R2_AVATARS_PUBLIC_URL
    R2_AVATARS_BUCKET_NAME: string;
    R2_AVATARS_PUBLIC_URL: string;

    // Separate bucket from feed/avatars — school logos are one-per-school,
    // replace-in-place branding assets used in headers, sidebars, ID cards,
    // and receipts. Same R2 account/credentials; only bucket + public URL differ.
    //
    // R2_LOGOS_BUCKET_NAME: e.g. "school-logos"
    // R2_LOGOS_PUBLIC_URL: the public base URL for the bucket — either the
    //   default r2.dev subdomain or a custom domain mapped to the bucket.
    //   No trailing slash.
    //
    // Local dev (.dev.vars — never commit):
    //   R2_LOGOS_BUCKET_NAME = "school-logos"
    //   R2_LOGOS_PUBLIC_URL = "https://pub-zzzz.r2.dev"
    //
    // Production (wrangler secret put):
    //   wrangler secret put R2_LOGOS_BUCKET_NAME
    //   wrangler secret put R2_LOGOS_PUBLIC_URL
    R2_LOGOS_BUCKET_NAME: string;
    R2_LOGOS_PUBLIC_URL: string;
  };
  Variables: {
    jwtPayload?: any;
    superUser?: SuperUserContext; // ← set by superTokenValidationMiddleware
  };
};

// School-specific environment with custom context variables
export type SchoolEnv = {
  Bindings: Env["Bindings"];
  Variables: {
    jwtPayload?: any;
    user?: SchoolUserContext; // ← For school user
    schoolCode?: string; // ← For easy access
  };
};
