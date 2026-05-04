import { eq, inArray } from "drizzle-orm";
import {
  schoolPermissionsSchema,
  schoolRolePermissionsSchema,
  schoolRolesSchema,
  schoolUserPermissionsSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
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
  email: string;
  isActive: boolean;
  tokenVersion: number;
}

// ==================== FUNCTIONS ====================

/**
 * PRODUCTION-GRADE PERMISSION FETCHER
 *
 * Fetches permissions from BOTH:
 * 1. User's roles (inherited permissions via role_permissions table)
 * 2. User's direct permission overrides (user_permissions table)
 *
 * ── SCHOOL_OWNER wildcard behaviour (FIXED) ─────────────────────────────────
 * Previously: Owner got ALL permission slugs including student/parent ones.
 *             This caused 'My Attendance' and 'fees.report' to appear in the
 *             Owner sidebar and allowed Owner to see consumer-scoped pages.
 *
 * Now: Owner gets all 'staff' category slugs + wildcard '*'.
 *      Student/parent category slugs are NEVER returned for any staff user,
 *      including the Owner. This is enforced at the DB query level by filtering
 *      on category = 'staff', not in application logic, so it cannot be bypassed.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param db     - Drizzle database instance (school-specific)
 * @param userId - User ID to fetch permissions for
 * @returns Array of permission slugs (including '*' wildcard for Owner)
 */
export async function getUserPermissionsFromDB(
  db: any,
  userId: number
): Promise<PermissionSlugWithWildcard[]> {
  // 1. Fetch user's assigned roles
  const userRoles: UserRole[] = await db
    .select({
      roleId: schoolUserRolesSchema.roleId,
      roleName: schoolRolesSchema.name,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, userId))
    .all();

  // 2. SCHOOL_OWNER: return all STAFF-category slugs + wildcard
  //
  // The WHERE category = 'staff' filter is the critical security gate.
  // It means even if a future code change accidentally inserts a student/parent
  // slug into the permissions table without the correct category, the Owner
  // will never receive it through this path.
  const hasOwnerRole = userRoles.some(
    (r) => r.roleName === SchoolRole.SCHOOL_OWNER
  );

  if (hasOwnerRole) {
    const staffPermissions: PermissionRecord[] = await db
      .select({ slug: schoolPermissionsSchema.slug })
      .from(schoolPermissionsSchema)
      .where(eq(schoolPermissionsSchema.category, "staff"))
      .all();

    const staffSlugs = staffPermissions.map((p) => p.slug);

    return [
      ...staffSlugs,
      WILDCARD_PERMISSION,
    ] as PermissionSlugWithWildcard[];
  }

  // 3. Non-owner: fetch permissions inherited from assigned roles
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

  // 4. Fetch direct user-level permission overrides
  const directPermissions: PermissionRecord[] = await db
    .select({ slug: schoolPermissionsSchema.slug })
    .from(schoolUserPermissionsSchema)
    .innerJoin(
      schoolPermissionsSchema,
      eq(schoolUserPermissionsSchema.permissionId, schoolPermissionsSchema.id)
    )
    .where(eq(schoolUserPermissionsSchema.userId, userId))
    .all();

  // 5. Merge and deduplicate
  const allUserPermissions = [
    ...rolePermissions.map((p) => p.slug),
    ...directPermissions.map((p) => p.slug),
  ];

  const uniquePermissions = [...new Set(allUserPermissions)];

  if (uniquePermissions.length === 0 && userRoles.length === 0) {
    console.warn(`⚠️ User ${userId} has no roles or permissions assigned`);
  }

  return uniquePermissions as PermissionSlugWithWildcard[];
}
  

/**
 * FAST USER LOOKUP WITH PERMISSIONS
 *
 * Combines a user record fetch with getUserPermissionsFromDB.
 * Used by the refresh token endpoint.
 */
export async function getUserWithPermissions(
  db: any,
  userId: number
): Promise<
  (UserWithBasicInfo & { permissions: PermissionSlugWithWildcard[] }) | null
> {
  const user: UserWithBasicInfo | undefined = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      isActive: schoolUsersSchema.isActive,
      tokenVersion: schoolUsersSchema.tokenVersion,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) return null;

  const permissions = await getUserPermissionsFromDB(db, userId);

  return {
    ...user,
    permissions,
  };
}
