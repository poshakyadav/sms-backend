import { eq, inArray } from "drizzle-orm";
import {
  superPermissionsSchema,
  superRolePermissionsSchema,
  superRolesSchema,
  superUserPermissionsSchema,
  superUserRolesSchema,
  superUsersSchema,
} from "../../../db/schemas/super";
import {
  SuperPermissionSlugWithWildcard,
  WILDCARD_PERMISSION,
} from "../../../types/super-permissions";
import { SuperRoleEnum } from "../../../types/super-role";

// ── Types ────────────────────────────────────────────────────────────────────

interface UserRole {
  roleId: number;
  roleName: string;
}

interface PermissionRecord {
  slug: string;
}

interface SuperUserBasicInfo {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
  tokenVersion: number;
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Fetches the effective permission slug array for a super user.
 *
 * Resolution order (mirrors school PBAC):
 *  1. If user has SUPERADMIN role → return all slugs + wildcard "*"
 *  2. Otherwise merge role-inherited slugs + direct user-permission overrides
 *  3. Deduplicate
 */
export async function getSuperUserPermissionsFromDB(
  db: any,
  userId: number
): Promise<SuperPermissionSlugWithWildcard[]> {
  // 1. Fetch user's roles
  const userRoles: UserRole[] = await db
    .select({
      roleId: superUserRolesSchema.roleId,
      roleName: superRolesSchema.name,
    })
    .from(superUserRolesSchema)
    .innerJoin(superRolesSchema, eq(superUserRolesSchema.roleId, superRolesSchema.id))
    .where(eq(superUserRolesSchema.userId, userId))
    .all();

  // 2. SUPERADMIN → wildcard
  const isSuperAdmin = userRoles.some((r) => r.roleName === SuperRoleEnum.SUPERADMIN);

  if (isSuperAdmin) {
    const allPermissions: PermissionRecord[] = await db
      .select({ slug: superPermissionsSchema.slug })
      .from(superPermissionsSchema)
      .all();

    return [
      ...allPermissions.map((p) => p.slug),
      WILDCARD_PERMISSION,
    ] as SuperPermissionSlugWithWildcard[];
  }

  // 3. Role-inherited permissions
  const roleIds = userRoles.map((r) => r.roleId);
  let rolePermissions: PermissionRecord[] = [];

  if (roleIds.length > 0) {
    rolePermissions = await db
      .select({ slug: superPermissionsSchema.slug })
      .from(superRolePermissionsSchema)
      .innerJoin(
        superPermissionsSchema,
        eq(superRolePermissionsSchema.permissionId, superPermissionsSchema.id)
      )
      .where(inArray(superRolePermissionsSchema.roleId, roleIds))
      .all();
  }

  // 4. Direct user-permission overrides
  const directPermissions: PermissionRecord[] = await db
    .select({ slug: superPermissionsSchema.slug })
    .from(superUserPermissionsSchema)
    .innerJoin(
      superPermissionsSchema,
      eq(superUserPermissionsSchema.permissionId, superPermissionsSchema.id)
    )
    .where(eq(superUserPermissionsSchema.userId, userId))
    .all();

  // 5. Merge + deduplicate
  const merged = [
    ...rolePermissions.map((p) => p.slug),
    ...directPermissions.map((p) => p.slug),
  ];

  return [...new Set(merged)] as SuperPermissionSlugWithWildcard[];
}

/**
 * Fetches a super user with their resolved permission slugs in one call.
 */
export async function getSuperUserWithPermissions(
  db: any,
  userId: number
): Promise<(SuperUserBasicInfo & { permissions: SuperPermissionSlugWithWildcard[] }) | null> {
  const user: SuperUserBasicInfo | undefined = await db
    .select({
      id: superUsersSchema.id,
      name: superUsersSchema.name,
      email: superUsersSchema.email,
      isActive: superUsersSchema.isActive,
      tokenVersion: superUsersSchema.tokenVersion,
    })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.id, userId))
    .get();

  if (!user) return null;

  const permissions = await getSuperUserPermissionsFromDB(db, userId);
  return { ...user, permissions };
}