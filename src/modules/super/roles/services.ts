import { and, eq, inArray, sql } from "drizzle-orm";
import {
  superPermissionsSchema,
  superRolePermissionsSchema,
  superRolesSchema,
  superUserRolesSchema,
  superUsersSchema,
} from "../../../db/schemas/super";

export async function getAllSuperRoles(db: any) {
  const roles = await db
    .select()
    .from(superRolesSchema)
    .orderBy(superRolesSchema.name)
    .all();
  if (roles.length === 0) return [];

  const roleIds = roles.map((r: any) => r.id);
  const permsData = await db
    .select({
      roleId: superRolePermissionsSchema.roleId,
      id: superPermissionsSchema.id,
      slug: superPermissionsSchema.slug,
      name: superPermissionsSchema.name,
      module: superPermissionsSchema.module,
    })
    .from(superRolePermissionsSchema)
    .innerJoin(
      superPermissionsSchema,
      eq(superRolePermissionsSchema.permissionId, superPermissionsSchema.id)
    )
    .where(inArray(superRolePermissionsSchema.roleId, roleIds))
    .all();

  const byRole = permsData.reduce((acc: any, p: any) => {
    if (!acc[p.roleId]) acc[p.roleId] = [];
    acc[p.roleId].push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      module: p.module,
    });
    return acc;
  }, {} as Record<number, any[]>);

  return roles.map((r: any) => ({ ...r, permissions: byRole[r.id] || [] }));
}

export async function getSuperRoleById(db: any, id: number) {
  const role = await db
    .select()
    .from(superRolesSchema)
    .where(eq(superRolesSchema.id, id))
    .get();
  if (!role) return null;

  const permissions = await db
    .select({
      id: superPermissionsSchema.id,
      slug: superPermissionsSchema.slug,
      name: superPermissionsSchema.name,
      module: superPermissionsSchema.module,
    })
    .from(superRolePermissionsSchema)
    .innerJoin(
      superPermissionsSchema,
      eq(superRolePermissionsSchema.permissionId, superPermissionsSchema.id)
    )
    .where(eq(superRolePermissionsSchema.roleId, id))
    .all();

  return { ...role, permissions };
}

export async function createSuperRole(
  db: any,
  data: { name: string; description: string; permissionIds: number[] }
) {
  return db.transaction(async (tx: any) => {
    const existing = await tx
      .select({ id: superRolesSchema.id })
      .from(superRolesSchema)
      .where(eq(superRolesSchema.name, data.name))
      .get();
    if (existing) throw new Error(`Role "${data.name}" already exists`);

    const valid = await tx
      .select({ id: superPermissionsSchema.id })
      .from(superPermissionsSchema)
      .where(inArray(superPermissionsSchema.id, data.permissionIds))
      .all();
    if (valid.length !== data.permissionIds.length)
      throw new Error("One or more invalid permission IDs");

    const [newRole] = await tx
      .insert(superRolesSchema)
      .values({
        name: data.name,
        description: data.description,
        isSystem: false,
      })
      .returning();

    await tx
      .insert(superRolePermissionsSchema)
      .values(
        data.permissionIds.map((permissionId) => ({
          roleId: newRole.id,
          permissionId,
        }))
      );

    return newRole;
  });
}

export async function updateSuperRole(
  db: any,
  id: number,
  data: { name?: string; description?: string; permissionIds?: number[] }
) {
  return db.transaction(async (tx: any) => {
    const role = await tx
      .select({ id: superRolesSchema.id, isSystem: superRolesSchema.isSystem })
      .from(superRolesSchema)
      .where(eq(superRolesSchema.id, id))
      .get();
    if (!role) throw new Error("Role not found");
    if (role.isSystem) throw new Error("Cannot modify system roles");

    if (data.name) {
      const conflict = await tx
        .select({ id: superRolesSchema.id })
        .from(superRolesSchema)
        .where(
          and(
            eq(superRolesSchema.name, data.name),
            sql`${superRolesSchema.id} != ${id}`
          )
        )
        .get();
      if (conflict) throw new Error(`Role name "${data.name}" already taken`);
    }

    if (data.name || data.description) {
      await tx
        .update(superRolesSchema)
        .set({
          ...(data.name && { name: data.name }),
          ...(data.description && { description: data.description }),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(superRolesSchema.id, id));
    }

    if (data.permissionIds) {
      const valid = await tx
        .select({ id: superPermissionsSchema.id })
        .from(superPermissionsSchema)
        .where(inArray(superPermissionsSchema.id, data.permissionIds))
        .all();
      if (valid.length !== data.permissionIds.length)
        throw new Error("One or more invalid permission IDs");

      await tx
        .delete(superRolePermissionsSchema)
        .where(eq(superRolePermissionsSchema.roleId, id));

      if (data.permissionIds.length > 0) {
        await tx
          .insert(superRolePermissionsSchema)
          .values(
            data.permissionIds.map((permissionId) => ({
              roleId: id,
              permissionId,
            }))
          );
      }

      // Invalidate tokens for all users with this role
      const affected = await tx
        .select({ userId: superUserRolesSchema.userId })
        .from(superUserRolesSchema)
        .where(eq(superUserRolesSchema.roleId, id))
        .all();
      if (affected.length > 0) {
        await tx
          .update(superUsersSchema)
          .set({ tokenVersion: sql`${superUsersSchema.tokenVersion} + 1` })
          .where(
            inArray(
              superUsersSchema.id,
              affected.map((u: any) => u.userId)
            )
          );
      }
    }
  });
}

export async function deleteSuperRole(db: any, id: number) {
  return db.transaction(async (tx: any) => {
    const role = await tx
      .select({ id: superRolesSchema.id, isSystem: superRolesSchema.isSystem })
      .from(superRolesSchema)
      .where(eq(superRolesSchema.id, id))
      .get();
    if (!role) throw new Error("Role not found");
    if (role.isSystem) throw new Error("Cannot delete system roles");

    const inUse = await tx
      .select({ userId: superUserRolesSchema.userId })
      .from(superUserRolesSchema)
      .where(eq(superUserRolesSchema.roleId, id))
      .limit(1)
      .get();
    if (inUse)
      throw new Error(
        "Cannot delete a role that is assigned to users. Reassign users first."
      );

    await tx.delete(superRolesSchema).where(eq(superRolesSchema.id, id));
  });
}
