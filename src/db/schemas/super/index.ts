export * from "./super-users";
export * from "./super-permissions";
export * from "./super-roles";
export * from "./super-role-permissions";
export * from "./super-user-roles";
export * from "./super-user-permissions";
export * from "./refresh-tokens";
export * from "./turso-databases";
export * from "./schools";

export * from "./payment-config";
export * from "./school-invitations";
export * from "./school-payment-records";
export * from "./password-reset-tokens";

export * from "./school-registration-requests";
export * from "./school-contact-messages";

// ── Razorpay integration (NEW) ──────────────────────────────────────────────
// Order matters only for readability here — Drizzle resolves FK references
// lazily, so exact export order does not affect correctness. Grouped in the
// rough dependency order: ledger → plans → customer mapping → autopay →
// access periods → bundles → bundle purchases.
export * from "./platform-payments"; // Depends on schools
export * from "./access-plans"; // No deps (besides shared types)
export * from "./school-razorpay-customers"; // Depends on schools
export * from "./school-autopay-subscriptions"; // Depends on schools, access-plans
export * from "./school-access-periods"; // Depends on schools, platform-payments
export * from "./message-bundles"; // No deps (besides shared types)
export * from "./school-bundle-purchases"; // Depends on schools, message-bundles, platform-payments


// ── WhatsApp cross-school wamid lookup (NEW) ────────────────────────────────
// Enables O(1) school resolution in the status webhook handler instead of
// scanning every active school's Turso DB.
export * from "./whatsapp-wamid-index";