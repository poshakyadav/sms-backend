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
    CONFIG: "payments.config", // Manage UPI / fee config
    APPROVE: "payments.approve", // Approve / reject payment proofs
    VIEW: "payments.view", // View payment records
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
    "school-requests.view",
    "contact-messages.view",
  ],
};
