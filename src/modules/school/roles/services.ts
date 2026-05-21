// src/modules/school/roles/services.ts
// UPDATED: Full category enforcement on createRole, updateRole, cloneRole.
// getAllRoles and getRoleById now return the `category` field.
// System role seeding writes correct category per role.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  schoolPermissionsSchema,
  schoolRolePermissionsSchema,
  schoolRolesSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { PermissionCategory } from "../../../types/school-permissions";

// ── Category label map for human-readable error messages ─────────────────────
const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  staff: "Staff",
  student: "Student",
  parent: "Parent",
};

// ==================== SHARED VALIDATION HELPER ====================
/**
 * Validates that ALL given permissionIds belong to the expected category.
 * Throws a descriptive error if any cross-category permissions are found.
 * Used by createRole, updateRole, and cloneRole.
 *
 * @param tx          - Drizzle transaction or db instance
 * @param permissionIds - Array of permission IDs to validate
 * @param expectedCategory - The category all permissions must belong to
 */
async function assertPermissionsCategoryMatch(
  tx: any,
  permissionIds: number[],
  expectedCategory: PermissionCategory
): Promise<void> {
  if (permissionIds.length === 0) return;

  // Fetch the categories of all submitted permission IDs in one query
  const perms = await tx
    .select({
      id: schoolPermissionsSchema.id,
      slug: schoolPermissionsSchema.slug,
      category: schoolPermissionsSchema.category,
    })
    .from(schoolPermissionsSchema)
    .where(inArray(schoolPermissionsSchema.id, permissionIds))
    .all();

  // Check for IDs that don't exist in the DB at all
  if (perms.length !== permissionIds.length) {
    throw new Error("One or more invalid permission IDs");
  }

  // Check for category mismatches
  const wrongCategory = perms.filter(
    (p: { id: number; slug: string; category: string }) =>
      p.category !== expectedCategory
  );

  if (wrongCategory.length > 0) {
    const slugList = wrongCategory
      .map(
        (p: { slug: string; category: string }) =>
          `"${p.slug}" (${
            CATEGORY_LABELS[p.category as PermissionCategory] ?? p.category
          })`
      )
      .join(", ");

    throw new Error(
      `Category mismatch: The following permissions do not belong to the ` +
        `"${CATEGORY_LABELS[expectedCategory]}" category: ${slugList}. ` +
        `Only ${CATEGORY_LABELS[expectedCategory]} permissions can be assigned to this role.`
    );
  }
}

// ==================== SHARED INNER TX FUNCTION ====================
/**
 * Core role creation logic — accepts a tx (or db) object directly.
 * Used by both createRole and cloneRole to stay within the same transaction.
 *
 * UPDATED: Now requires `category` and enforces cross-category validation
 * via assertPermissionsCategoryMatch before inserting.
 */
async function createRoleInTx(
  tx: any,
  data: {
    name: string;
    description: string;
    permissionIds: number[];
    category: PermissionCategory;
  }
): Promise<{ role: typeof schoolRolesSchema.$inferSelect }> {
  // 1. Check if role name already exists
  const existingRole = await tx
    .select({ id: schoolRolesSchema.id })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.name, data.name))
    .get();

  if (existingRole) {
    throw new Error(`Role "${data.name}" already exists`);
  }

  // 2. Validate permissions exist AND belong to the correct category
  await assertPermissionsCategoryMatch(tx, data.permissionIds, data.category);

  // 3. Create role with category
  const [newRole] = await tx
    .insert(schoolRolesSchema)
    .values({
      name: data.name,
      description: data.description,
      isSystem: false, // Custom roles are never system roles
      category: data.category,
    })
    .returning();

  // 4. Assign permissions
  if (data.permissionIds.length > 0) {
    await tx.insert(schoolRolePermissionsSchema).values(
      data.permissionIds.map((permissionId: number) => ({
        roleId: newRole.id,
        permissionId,
      }))
    );
  }

  return { role: newRole };
}

// ==================== GET ALL ROLES ====================
// ==================== GET ALL ROLES ====================
export async function getAllRoles(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  category?: "staff" | "student" | "parent"
) {
  const db = await getSchoolDB(env, schoolCode);

  // Build base query — filter by category when provided
  const rolesQuery = db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
      createdAt: schoolRolesSchema.createdAt,
    })
    .from(schoolRolesSchema)
    .orderBy(schoolRolesSchema.name);

  const roles = category
    ? await rolesQuery.where(eq(schoolRolesSchema.category, category)).all()
    : await rolesQuery.all();

  if (roles.length === 0) return [];

  // Fetch permissions for the returned roles
  const roleIds = roles.map((r) => r.id);

  const permissionsData = await db
    .select({
      roleId: schoolRolePermissionsSchema.roleId,
      permissionId: schoolPermissionsSchema.id,
      slug: schoolPermissionsSchema.slug,
      name: schoolPermissionsSchema.name,
      module: schoolPermissionsSchema.module,
      category: schoolPermissionsSchema.category,
    })
    .from(schoolRolePermissionsSchema)
    .innerJoin(
      schoolPermissionsSchema,
      eq(schoolRolePermissionsSchema.permissionId, schoolPermissionsSchema.id)
    )
    .where(inArray(schoolRolePermissionsSchema.roleId, roleIds))
    .all();

  // Group permissions by role
  const permissionsByRole = permissionsData.reduce(
    (acc: Record<number, any[]>, perm: any) => {
      if (!acc[perm.roleId]) acc[perm.roleId] = [];
      acc[perm.roleId].push({
        id: perm.permissionId,
        slug: perm.slug,
        name: perm.name,
        module: perm.module,
        category: perm.category,
      });
      return acc;
    },
    {} as Record<number, any[]>
  );

  return roles.map((role) => ({
    ...role,
    permissions: permissionsByRole[role.id] || [],
    permissionCount: (permissionsByRole[role.id] || []).length,
  }));
}

// ==================== GET ROLE BY ID ====================
export async function getRoleById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // UPDATED: Include `category`
  const role = await db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
      createdAt: schoolRolesSchema.createdAt,
    })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.id, id))
    .get();

  if (!role) return null;

  // Fetch permissions including their category
  const permissions = await db
    .select({
      id: schoolPermissionsSchema.id,
      slug: schoolPermissionsSchema.slug,
      name: schoolPermissionsSchema.name,
      module: schoolPermissionsSchema.module,
      category: schoolPermissionsSchema.category,
    })
    .from(schoolRolePermissionsSchema)
    .innerJoin(
      schoolPermissionsSchema,
      eq(schoolRolePermissionsSchema.permissionId, schoolPermissionsSchema.id)
    )
    .where(eq(schoolRolePermissionsSchema.roleId, id))
    .all();

  return {
    ...role,
    permissions,
  };
}

// ==================== CREATE ROLE (public) ====================
export async function createRole(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    name: string;
    description: string;
    permissionIds: number[];
    category: PermissionCategory; // REQUIRED — must be explicit
    templateId?: string;
  },
  _createdBy: number
) {
  const db = await getSchoolDB(env, schoolCode);
  return db.transaction((tx: any) =>
    createRoleInTx(tx, {
      name: data.name,
      description: data.description,
      permissionIds: data.permissionIds,
      category: data.category,
    })
  );
}

// ==================== UPDATE ROLE ====================
export async function updateRole(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: {
    name?: string;
    description?: string;
    permissionIds?: number[];
    // NOTE: category is intentionally NOT in the update payload.
    // A role's category is immutable after creation.
  },
  _updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx: any) => {
    // 1. Check role exists and is not system role
    const existingRole = await tx
      .select({
        id: schoolRolesSchema.id,
        isSystem: schoolRolesSchema.isSystem,
        category: schoolRolesSchema.category,
      })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.id, id))
      .get();

    if (!existingRole) {
      throw new Error("Role not found");
    }

    if (existingRole.isSystem) {
      throw new Error("Cannot modify system roles");
    }

    // 2. Check name uniqueness if changing
    if (data.name) {
      const nameConflict = await tx
        .select({ id: schoolRolesSchema.id })
        .from(schoolRolesSchema)
        .where(
          and(
            eq(schoolRolesSchema.name, data.name),
            sql`${schoolRolesSchema.id} != ${id}`
          )
        )
        .get();

      if (nameConflict) {
        throw new Error(`Role "${data.name}" already exists`);
      }
    }

    // 3. Update role metadata
    if (data.name || data.description) {
      await tx
        .update(schoolRolesSchema)
        .set({
          ...(data.name && { name: data.name }),
          ...(data.description && { description: data.description }),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(schoolRolesSchema.id, id));
    }

    // 4. Update permissions if provided
    if (data.permissionIds) {
      // UPDATED: Validate category consistency using the role's EXISTING category
      // (category is immutable — we read it from the DB, not from the request)
      await assertPermissionsCategoryMatch(
        tx,
        data.permissionIds,
        existingRole.category as PermissionCategory
      );

      // Delete old → insert new (replace strategy)
      await tx
        .delete(schoolRolePermissionsSchema)
        .where(eq(schoolRolePermissionsSchema.roleId, id));

      // Insert new permissions
      if (data.permissionIds.length > 0) {
        await tx.insert(schoolRolePermissionsSchema).values(
          data.permissionIds.map((permissionId: number) => ({
            roleId: id,
            permissionId,
          }))
        );
      }

      // 5. Increment tokenVersion for all users with this role
      // (invalidates existing sessions so permission changes take effect immediately)
      const usersWithRole = await tx
        .select({ userId: schoolUserRolesSchema.userId })
        .from(schoolUserRolesSchema)
        .where(eq(schoolUserRolesSchema.roleId, id))
        .all();

      if (usersWithRole.length > 0) {
        const userIds = usersWithRole.map((u: { userId: number }) => u.userId);

        await tx
          .update(schoolUsersSchema)
          .set({ tokenVersion: sql`${schoolUsersSchema.tokenVersion} + 1` })
          .where(inArray(schoolUsersSchema.id, userIds));

        console.log(
          `🔄 Invalidated tokens for ${usersWithRole.length} users with role ID ${id}`
        );
      }
    }

    return { message: "Role updated successfully" };
  });
}

// ==================== CLONE ROLE ====================
export async function cloneRole(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  sourceRoleId: number,
  data: {
    name: string;
    description?: string;
  },
  createdBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return db.transaction(async (tx: any) => {
    // 1. Verify source role exists and read its category
    const sourceRole = await tx
      .select({
        id: schoolRolesSchema.id,
        name: schoolRolesSchema.name,
        category: schoolRolesSchema.category,
      })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.id, sourceRoleId))
      .get();

    if (!sourceRole) throw new Error("Source role not found");

    // 2. Fetch its permissions
    const sourcePermissions = await tx
      .select({ permissionId: schoolRolePermissionsSchema.permissionId })
      .from(schoolRolePermissionsSchema)
      .where(eq(schoolRolePermissionsSchema.roleId, sourceRoleId))
      .all();

    if (sourcePermissions.length === 0) {
      throw new Error("Source role has no permissions to clone");
    }

    const permissionIds = sourcePermissions.map(
      (p: { permissionId: number }) => p.permissionId
    );

    // 3. Create the new role inside the SAME transaction
    // UPDATED: Inherit category from source role — cloned roles always
    // stay in the same permission universe as their source.
    return createRoleInTx(tx, {
      name: data.name,
      description: data.description || `Cloned from "${sourceRole.name}"`,
      permissionIds,
      category: sourceRole.category as PermissionCategory,
    });
  });
}

// ==================== DELETE ROLE ====================
export async function deleteRole(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx: any) => {
    // 1. Check role exists and is not system role
    const role = await tx
      .select({
        id: schoolRolesSchema.id,
        isSystem: schoolRolesSchema.isSystem,
      })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.id, id))
      .get();

    if (!role) {
      throw new Error("Role not found");
    }

    if (role.isSystem) {
      throw new Error("Cannot delete system roles");
    }

    // 2. Guard: reject if any user still has this role
    const usersWithRole = await tx
      .select({ userId: schoolUserRolesSchema.userId })
      .from(schoolUserRolesSchema)
      .where(eq(schoolUserRolesSchema.roleId, id))
      .limit(1)
      .get();

    if (usersWithRole) {
      throw new Error(
        "Cannot delete role that is assigned to users. Please reassign users first."
      );
    }

    // 3. Delete role (cascades handle role_permissions)
    await tx.delete(schoolRolesSchema).where(eq(schoolRolesSchema.id, id));

    return { message: "Role deleted successfully" };
  });
}

// ==================== ROLE TEMPLATES ====================
// UPDATED: Each template now declares its category explicitly.
// All current templates are staff-category since they model school staff roles.
export function getRoleTemplates() {
  return [
    {
      id: "standard_teacher",
      name: "Standard Teacher",
      description: "Basic teacher permissions for classroom management",
      category: "staff" as PermissionCategory,
      permissionSlugs: [
        "dashboard.view",
        "attendance.mark",
        "assignments.create",
        "assignments.edit",
        "assignments.grade",
        "exams.marks.enter",
        "notifications.view",
      ],
    },
    {
      id: "senior_teacher",
      name: "Senior Teacher",
      description: "Enhanced teacher with exam and assignment management",
      category: "staff" as PermissionCategory,
      permissionSlugs: [
        "dashboard.view",
        "attendance.mark",
        "attendance.report",
        "assignments.create",
        "assignments.edit",
        "assignments.delete",
        "assignments.grade",
        "exams.create",
        "exams.edit",
        "exams.marks.enter",
        "notifications.send",
        "notifications.view",
      ],
    },
    {
      id: "admin_staff",
      name: "Administrative Staff",
      description: "Front-office and administrative permissions",
      category: "staff" as PermissionCategory,
      permissionSlugs: [
        "dashboard.view",
        "users.list",
        "academics.enroll",
        "fees.payments.record",
        "fees.report",
        "notifications.view",
      ],
    },
    {
      id: "accountant",
      name: "Accountant",
      description: "Financial management permissions",
      category: "staff" as PermissionCategory,
      permissionSlugs: [
        "dashboard.view",
        "users.list",
        "fees.structures.manage",
        "fees.payments.record",
        "fees.report",
        "fees.ledger.view",
      ],
    },
  ];
}
