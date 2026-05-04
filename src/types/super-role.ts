// Keep the enum for seeding role names only.
// Runtime authorization is now fully slug-based (see super-permissions.ts).
export enum SuperRoleEnum {
  SUPERADMIN = "SUPERADMIN",
  SUPERMANAGER = "SUPERMANAGER",
  SUPERUSER = "SUPERUSER",
}

/** @deprecated Use SuperPermissionSlug for all authorization checks. */
export type LegacySuperRole = SuperRoleEnum;
