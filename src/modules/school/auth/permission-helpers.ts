// …/school/auth/permission-helpers.ts

import { eq, inArray } from "drizzle-orm";
import {
  schoolPermissionsSchema,
  schoolRolePermissionsSchema,
  schoolRolesSchema,
  schoolUserPermissionsSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { schoolUserPermissionDenialsSchema } from "../../../db/schemas/school/school-user-permission-denials";
import {
  PermissionSlugWithWildcard,
  WILDCARD_PERMISSION,
} from "../../../types/school-permissions";
import { SchoolRole } from "../../../types/school-role";

// ==================== TYPE DEFINITIONS ====================
interface UserRole {
  roleId: number;
  roleName: string;
}

interface PermissionRecord {
  slug: string;
}

interface UserWithBasicInfo {
  id: number;
  name: string;
  email: string | null; // now nullable
  username: string;
  isActive: boolean;
  tokenVersion: number;
  primaryRole: string | null;
}

// ==================== FUNCTIONS ====================

/**
 * PRODUCTION-GRADE PERMISSION FETCHER (UPDATED)
 *
 * Fetches effective permissions from:
 *   1. Role-inherited permissions (via role_permissions table)
 *   2. Direct user-level grants (user_permissions table)       ← adds slugs
 *   3. Explicit denials (user_permission_denials table)        ← removes slugs (HIGHEST PRIORITY)
 *
 * A denial always wins — even if a permission appears in both grants and denials,
 * the denial removes it from the effective set.
 *
 * ── SCHOOL_OWNER wildcard behaviour ─────────────────────────────────────────
 * Owner gets all 'staff' category slugs + wildcard '*'.
 * Student/parent category slugs are NEVER returned for staff users.
 * Denials still apply to the Owner (rare but supported).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param db     - Drizzle database instance (school-specific)
 * @param userId - User ID to fetch permissions for
 * @returns Array of effective permission slugs
 *
 */
export async function getUserPermissionsFromDB(
  db: any,
  userId: number
): Promise<PermissionSlugWithWildcard[]> {
  // ── Batch 1: roles + denials + direct grants in ONE round trip ──────────
  const [userRoles, deniedPermissions, directPermissions] = (await db.batch([
    db
      .select({
        roleId: schoolUserRolesSchema.roleId,
        roleName: schoolRolesSchema.name,
      })
      .from(schoolUserRolesSchema)
      .innerJoin(
        schoolRolesSchema,
        eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
      )
      .where(eq(schoolUserRolesSchema.userId, userId)),

    db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolUserPermissionDenialsSchema)
      .innerJoin(
        schoolPermissionsSchema,
        eq(
          schoolUserPermissionDenialsSchema.permissionId,
          schoolPermissionsSchema.id
        )
      )
      .where(eq(schoolUserPermissionDenialsSchema.userId, userId)),

    db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolUserPermissionsSchema)
      .innerJoin(
        schoolPermissionsSchema,
        eq(schoolUserPermissionsSchema.permissionId, schoolPermissionsSchema.id)
      )
      .where(eq(schoolUserPermissionsSchema.userId, userId)),
  ])) as [UserRole[], PermissionRecord[], PermissionRecord[]];

  const deniedSlugs = new Set(deniedPermissions.map((p) => p.slug));
  const hasOwnerRole = userRoles.some(
    (r) => r.roleName === SchoolRole.SCHOOL_OWNER
  );

  // ── SCHOOL_OWNER fast path ──────────────────────────────────────────────
  if (hasOwnerRole) {
    // One extra query — unavoidable since we need hasOwnerRole first
    const staffPermissions: PermissionRecord[] = await db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolPermissionsSchema)
      .where(eq(schoolPermissionsSchema.category, "staff"))
      .all();

    const staffSlugs = staffPermissions
      .map((p) => p.slug)
      .filter((s) => !deniedSlugs.has(s));

    const effectiveSlugs: PermissionSlugWithWildcard[] = [
      ...staffSlugs,
    ] as PermissionSlugWithWildcard[];

    if (!deniedSlugs.has(WILDCARD_PERMISSION as string)) {
      effectiveSlugs.push(WILDCARD_PERMISSION);
    }

    return effectiveSlugs;
  }

  // ── Non-owner: fetch role permissions (needs roleIds from batch above) ──
  const roleIds = userRoles.map((r) => r.roleId);

  let rolePermissions: PermissionRecord[] = [];
  if (roleIds.length > 0) {
    rolePermissions = await db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolRolePermissionsSchema)
      .innerJoin(
        schoolPermissionsSchema,
        eq(schoolRolePermissionsSchema.permissionId, schoolPermissionsSchema.id)
      )
      .where(inArray(schoolRolePermissionsSchema.roleId, roleIds))
      .all();
  }

  // ── Merge, deduplicate, subtract denials ────────────────────────────────
  const allSlugs = [
    ...rolePermissions.map((p) => p.slug),
    ...directPermissions.map((p) => p.slug),
  ];

  const uniqueSlugs = [...new Set(allSlugs)].filter((s) => !deniedSlugs.has(s));

  if (uniqueSlugs.length === 0 && userRoles.length === 0) {
    console.warn(`⚠️ User ${userId} has no roles or permissions assigned`);
  }

  return uniqueSlugs as PermissionSlugWithWildcard[];
}

// ==================== USER + PERMISSIONS IN ONE BATCH ====================

/**
 * Fetches user record AND all permission data in a single db.batch() call.
 *
 * Used by the refresh token endpoint. The user SELECT joins the same batch
 * as the permission queries — everything resolves in 2 round trips total.
 *
 * Also returns primaryRole directly from school_users (same batch),
 * eliminating the extra primaryRole query that was in the refresh handler.
 *
 * Round trips:
 *   Batch 1: [user, roles, denials, directPerms]  ← 1 round trip
 *   Query 2: rolePermissions (if non-owner)        ← 1 round trip
 *   Total: 2 instead of 5
 */
export async function getUserWithPermissions(
  db: any,
  userId: number
): Promise<
  (UserWithBasicInfo & { permissions: PermissionSlugWithWildcard[] }) | null
> {
  // ── Super-batch: user + all permission base queries in 1 round trip ─────
  const [users, userRoles, deniedPermissions, directPermissions] =
    (await db.batch([
      // User record — includes primaryRole so caller doesn't need extra query
      db
        .select({
          id: schoolUsersSchema.id,
          name: schoolUsersSchema.name,
          email: schoolUsersSchema.email,
          username: schoolUsersSchema.username,
          isActive: schoolUsersSchema.isActive,
          tokenVersion: schoolUsersSchema.tokenVersion,
          primaryRole: schoolUsersSchema.primaryRole,
        })
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.id, userId)),

      // Roles
      db
        .select({
          roleId: schoolUserRolesSchema.roleId,
          roleName: schoolRolesSchema.name,
        })
        .from(schoolUserRolesSchema)
        .innerJoin(
          schoolRolesSchema,
          eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
        )
        .where(eq(schoolUserRolesSchema.userId, userId)),

      // Denied permissions
      db
        .select({ slug: schoolPermissionsSchema.slug })
        .from(schoolUserPermissionDenialsSchema)
        .innerJoin(
          schoolPermissionsSchema,
          eq(
            schoolUserPermissionDenialsSchema.permissionId,
            schoolPermissionsSchema.id
          )
        )
        .where(eq(schoolUserPermissionDenialsSchema.userId, userId)),

      // Direct grants
      db
        .select({ slug: schoolPermissionsSchema.slug })
        .from(schoolUserPermissionsSchema)
        .innerJoin(
          schoolPermissionsSchema,
          eq(
            schoolUserPermissionsSchema.permissionId,
            schoolPermissionsSchema.id
          )
        )
        .where(eq(schoolUserPermissionsSchema.userId, userId)),
    ])) as [
      UserWithBasicInfo[],
      UserRole[],
      PermissionRecord[],
      PermissionRecord[]
    ];

  const user = users[0];
  if (!user) return null;

  const deniedSlugs = new Set(deniedPermissions.map((p) => p.slug));
  const hasOwnerRole = userRoles.some(
    (r) => r.roleName === SchoolRole.SCHOOL_OWNER
  );

  let permissions: PermissionSlugWithWildcard[];

  if (hasOwnerRole) {
    const staffPermissions: PermissionRecord[] = await db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolPermissionsSchema)
      .where(eq(schoolPermissionsSchema.category, "staff"))
      .all();

    const staffSlugs = staffPermissions
      .map((p) => p.slug)
      .filter((s) => !deniedSlugs.has(s));

    permissions = [...staffSlugs] as PermissionSlugWithWildcard[];
    if (!deniedSlugs.has(WILDCARD_PERMISSION as string)) {
      permissions.push(WILDCARD_PERMISSION);
    }
  } else {
    const roleIds = userRoles.map((r) => r.roleId);

    let rolePermissions: PermissionRecord[] = [];
    if (roleIds.length > 0) {
      rolePermissions = await db
        .select({ slug: schoolPermissionsSchema.slug })
        .from(schoolRolePermissionsSchema)
        .innerJoin(
          schoolPermissionsSchema,
          eq(
            schoolRolePermissionsSchema.permissionId,
            schoolPermissionsSchema.id
          )
        )
        .where(inArray(schoolRolePermissionsSchema.roleId, roleIds))
        .all();
    }

    const allSlugs = [
      ...rolePermissions.map((p) => p.slug),
      ...directPermissions.map((p) => p.slug),
    ];

    permissions = [...new Set(allSlugs)].filter(
      (s) => !deniedSlugs.has(s)
    ) as PermissionSlugWithWildcard[];
  }

  return { ...user, permissions };
}
