/**
 * Atomic PBAC permission slugs for the super-admin platform.
 * Grouped by module for a clean Permission Matrix UI.
 * SUPERADMIN gets a special "*" wildcard — handled in code, never stored in DB.
 */

export const SUPER_PERMISSIONS = {
  USERS: {
    LIST: "users.list",
    CREATE: "users.create",
    EDIT: "users.edit",
    DELETE: "users.delete",
  },
  ROLES: {
    MANAGE: "roles.manage",
  },
  PERMISSIONS: {
    MANAGE: "permissions.manage",
  },
  SCHOOLS: {
    LIST: "schools.list",
    CREATE: "schools.create",
    MANAGE: "schools.manage",
    INVITE: "schools.invite",
    ASSIGN_DB: "schools.assign-db",
  },
  TURSO: {
    MANAGE: "turso.manage",
  },
  DASHBOARD: {
    VIEW: "dashboard.view",
  },
  PAYMENTS: {
    CONFIG: "payments.config", // Manage UPI / setup-fee config (legacy + Razorpay setup fee)
    APPROVE: "payments.approve", // Approve / reject legacy manual UTR payment proofs
    VIEW: "payments.view", // View payment records (legacy school_payment_records)
  },

  // ── NEW: Razorpay platform payments ledger (platform_payments table) ─────
  PLATFORM_PAYMENTS: {
    VIEW: "platform-payments.view", // View the unified Razorpay payments ledger
    REFUND: "platform-payments.refund", // Issue refunds against a captured payment
  },

  // ── NEW: Access plans (Monthly ₹599 / Yearly ₹8985) ───────────────────────
  ACCESS_PLANS: {
    VIEW: "access-plans.view",
    MANAGE: "access-plans.manage", // Edit discountPaise, toggle autopayEnabled/isActive
  },

  // ── NEW: Message bundles catalog (WhatsApp now, Email/SMS later) ─────────
  MESSAGE_BUNDLES: {
    VIEW: "message-bundles.view",
    MANAGE: "message-bundles.manage", // Create/edit bundles, pricing, discounts
  },

  // ── NEW: Per-school access & autopay visibility/override ─────────────────
  SCHOOL_ACCESS: {
    VIEW: "school-access.view", // View any school's access period / autopay status
    OVERRIDE: "school-access.override", // Manually grant/extend access (goodwill, support cases)
  },

  SCHOOL_REQUESTS: {
    VIEW: "school-requests.view",
    MANAGE: "school-requests.manage",
  },
  CONTACT_MESSAGES: {
    VIEW: "contact-messages.view",
    MANAGE: "contact-messages.manage",
  },
} as const;

export type SuperPermissionSlug = {
  [K in keyof typeof SUPER_PERMISSIONS]: (typeof SUPER_PERMISSIONS)[K][keyof (typeof SUPER_PERMISSIONS)[K]];
}[keyof typeof SUPER_PERMISSIONS];

export const WILDCARD_PERMISSION = "*" as const;

export type SuperPermissionSlugWithWildcard =
  | SuperPermissionSlug
  | typeof WILDCARD_PERMISSION;

export const ALL_SUPER_PERMISSION_SLUGS = Object.values(
  SUPER_PERMISSIONS
).flatMap((mod) => Object.values(mod)) as readonly SuperPermissionSlug[];

// Default permission sets keyed by legacy role name string.
// Used only during the one-time seeder — not for runtime auth.
export const DEFAULT_ROLE_PERMISSIONS: Record<string, SuperPermissionSlug[]> = {
  SUPERADMIN: [...ALL_SUPER_PERMISSION_SLUGS], // gets * at runtime via wildcard check
  SUPERMANAGER: [
    "dashboard.view",
    "users.list",
    "users.edit",
    "schools.list",
    "schools.manage",
    "schools.invite",
    "schools.assign-db",
    "turso.manage",
    "payments.config",
    "payments.approve",
    "payments.view",
    "platform-payments.view",
    "platform-payments.refund",
    "access-plans.view",
    "access-plans.manage",
    "message-bundles.view",
    "message-bundles.manage",
    "school-access.view",
    "school-access.override",
    "school-requests.view",
    "school-requests.manage",
    "contact-messages.view",
    "contact-messages.manage",
  ],
  SUPERUSER: [
    "dashboard.view",
    "schools.list",
    "schools.invite",
    "turso.manage",
    "payments.view",
    "platform-payments.view",
    "access-plans.view",
    "message-bundles.view",
    "school-access.view",
    "school-requests.view",
    "contact-messages.view",
  ],
};
