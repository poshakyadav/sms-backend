import { and, eq, inArray, sql } from "drizzle-orm";
import {
  superPermissionsSchema,
  superRolesSchema,
  superUserPermissionsSchema,
  superUserRolesSchema,
  superUsersSchema,
} from "../../../db/schemas/super";
import { hashPassword } from "../../../utils/hashing";
import { getSuperUserPermissionsFromDB } from "../auth/permission-helpers";
import { SuperRoleEnum } from "../../../types/super-role";

// ── List ──────────────────────────────────────────────────────────────────────

export async function getSuperUsers(db: any) {
  const users = await db
    .select({
      id: superUsersSchema.id,
      name: superUsersSchema.name,
      email: superUsersSchema.email,
      isActive: superUsersSchema.isActive,
      tokenVersion: superUsersSchema.tokenVersion,
      createdAt: superUsersSchema.createdAt,
    })
    .from(superUsersSchema)
    .orderBy(superUsersSchema.name)
    .all();

  if (users.length === 0) return [];

  const userIds = users.map((u: any) => u.id);

  const rolesData = await db
    .select({
      userId: superUserRolesSchema.userId,
      roleId: superRolesSchema.id,
      roleName: superRolesSchema.name,
      isSystem: superRolesSchema.isSystem,
    })
    .from(superUserRolesSchema)
    .innerJoin(
      superRolesSchema,
      eq(superUserRolesSchema.roleId, superRolesSchema.id)
    )
    .where(inArray(superUserRolesSchema.userId, userIds))
    .all();

  const rolesByUser = rolesData.reduce((acc: any, r: any) => {
    if (!acc[r.userId]) acc[r.userId] = [];
    acc[r.userId].push({
      id: r.roleId,
      name: r.roleName,
      isSystem: r.isSystem,
    });
    return acc;
  }, {} as Record<number, any[]>);

  return users.map((u: any) => ({
    ...u,
    roles: rolesByUser[u.id] || [],
    // Expose isDeletable so the UI can disable the delete button
    isDeletable: !(rolesByUser[u.id] || []).some(
      (r: any) => r.name === SuperRoleEnum.SUPERADMIN
    ),
  }));
}

// ── Get by ID ─────────────────────────────────────────────────────────────────

export async function getSuperUserById(db: any, id: number) {
  const user = await db
    .select({
      id: superUsersSchema.id,
      name: superUsersSchema.name,
      email: superUsersSchema.email,
      isActive: superUsersSchema.isActive,
      tokenVersion: superUsersSchema.tokenVersion,
      createdAt: superUsersSchema.createdAt,
    })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.id, id))
    .get();

  if (!user) return null;

  const roles = await db
    .select({
      id: superRolesSchema.id,
      name: superRolesSchema.name,
      isSystem: superRolesSchema.isSystem,
    })
    .from(superUserRolesSchema)
    .innerJoin(
      superRolesSchema,
      eq(superUserRolesSchema.roleId, superRolesSchema.id)
    )
    .where(eq(superUserRolesSchema.userId, id))
    .all();

  const isDeletable = !roles.some(
    (r: any) => r.name === SuperRoleEnum.SUPERADMIN
  );

  return { ...user, roles, isDeletable };
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createSuperUser(
  db: any,
  data: { name: string; email: string; password: string; roleIds: number[] }
) {
  const existing = await db
    .select({ id: superUsersSchema.id })
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, data.email))
    .get();
  if (existing) throw new Error("Email already taken");

  // Validate roles exist
  const validRoles = await db
    .select({ id: superRolesSchema.id, name: superRolesSchema.name })
    .from(superRolesSchema)
    .where(inArray(superRolesSchema.id, data.roleIds))
    .all();
  if (validRoles.length !== data.roleIds.length)
    throw new Error("One or more invalid role IDs");

  // ── SUPERADMIN protection ────────────────────────────────────────────────
  // Only one SUPERADMIN may ever exist. If any roleId maps to SUPERADMIN, reject.
  const wantsAdmin = validRoles.some(
    (r: any) => r.name === SuperRoleEnum.SUPERADMIN
  );
  if (wantsAdmin) {
    throw new Error(
      "The SUPERADMIN role is reserved for the primary administrator and cannot be assigned to new users. " +
        "Assign SUPERMANAGER or SUPERUSER instead."
    );
  }

  const passwordHash = await hashPassword(data.password);

  return db.transaction(async (tx: any) => {
    const [newUser] = await tx
      .insert(superUsersSchema)
      .values({
        name: data.name,
        email: data.email,
        passwordHash,
        tokenVersion: 0,
      })
      .returning();

    await tx
      .insert(superUserRolesSchema)
      .values(data.roleIds.map((roleId) => ({ userId: newUser.id, roleId })));

    return { ...newUser, roles: validRoles };
  });
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateSuperUser(
  db: any,
  id: number,
  data: {
    name?: string;
    email?: string;
    newPassword?: string;
    isActive?: boolean;
  }
) {
  return db.transaction(async (tx: any) => {
    const existing = await tx
      .select({
        id: superUsersSchema.id,
        email: superUsersSchema.email,
        tokenVersion: superUsersSchema.tokenVersion,
      })
      .from(superUsersSchema)
      .where(eq(superUsersSchema.id, id))
      .get();
    if (!existing) throw new Error("User not found");

    if (data.email && data.email !== existing.email) {
      const taken = await tx
        .select({ id: superUsersSchema.id })
        .from(superUsersSchema)
        .where(
          and(
            eq(superUsersSchema.email, data.email),
            sql`${superUsersSchema.id} != ${id}`
          )
        )
        .get();
      if (taken) throw new Error("Email already taken");
    }

    const updatePayload: any = { updatedAt: sql`CURRENT_TIMESTAMP` };
    if (data.name !== undefined) updatePayload.name = data.name;
    if (data.email !== undefined) updatePayload.email = data.email;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;
    if (data.newPassword) {
      updatePayload.passwordHash = await hashPassword(data.newPassword);
      updatePayload.tokenVersion = existing.tokenVersion + 1; // invalidate old tokens
    }

    const [updated] = await tx
      .update(superUsersSchema)
      .set(updatePayload)
      .where(eq(superUsersSchema.id, id))
      .returning();

    return updated;
  });
}

// ── Assign roles ──────────────────────────────────────────────────────────────

export async function assignRolesToSuperUser(
  db: any,
  userId: number,
  roleIds: number[]
) {
  return db.transaction(async (tx: any) => {
    const user = await tx
      .select({
        id: superUsersSchema.id,
        tokenVersion: superUsersSchema.tokenVersion,
      })
      .from(superUsersSchema)
      .where(eq(superUsersSchema.id, userId))
      .get();
    if (!user) throw new Error("User not found");

    const validRoles = await tx
      .select({ id: superRolesSchema.id, name: superRolesSchema.name })
      .from(superRolesSchema)
      .where(inArray(superRolesSchema.id, roleIds))
      .all();
    if (validRoles.length !== roleIds.length)
      throw new Error("One or more invalid role IDs");

    // ── SUPERADMIN role assignment protection ────────────────────────────
    const wantsAdmin = validRoles.some(
      (r: any) => r.name === SuperRoleEnum.SUPERADMIN
    );
    if (wantsAdmin) {
      throw new Error(
        "The SUPERADMIN role cannot be assigned via this endpoint."
      );
    }

    await tx
      .delete(superUserRolesSchema)
      .where(eq(superUserRolesSchema.userId, userId));
    await tx
      .insert(superUserRolesSchema)
      .values(roleIds.map((roleId) => ({ userId, roleId })));

    const newTokenVersion = user.tokenVersion + 1;
    await tx
      .update(superUsersSchema)
      .set({ tokenVersion: newTokenVersion })
      .where(eq(superUsersSchema.id, userId));

    return { newTokenVersion };
  });
}

// ── Get / assign direct permissions ──────────────────────────────────────────

export async function getSuperUserDirectPermissions(db: any, userId: number) {
  return db
    .select({
      id: superPermissionsSchema.id,
      slug: superPermissionsSchema.slug,
      name: superPermissionsSchema.name,
      module: superPermissionsSchema.module,
    })
    .from(superUserPermissionsSchema)
    .innerJoin(
      superPermissionsSchema,
      eq(superUserPermissionsSchema.permissionId, superPermissionsSchema.id)
    )
    .where(eq(superUserPermissionsSchema.userId, userId))
    .all();
}

export async function assignDirectPermissionsToSuperUser(
  db: any,
  userId: number,
  permissionIds: number[]
) {
  return db.transaction(async (tx: any) => {
    const user = await tx
      .select({
        id: superUsersSchema.id,
        tokenVersion: superUsersSchema.tokenVersion,
      })
      .from(superUsersSchema)
      .where(eq(superUsersSchema.id, userId))
      .get();
    if (!user) throw new Error("User not found");

    if (permissionIds.length > 0) {
      const valid = await tx
        .select({ id: superPermissionsSchema.id })
        .from(superPermissionsSchema)
        .where(inArray(superPermissionsSchema.id, permissionIds))
        .all();
      if (valid.length !== permissionIds.length)
        throw new Error("One or more invalid permission IDs");
    }

    await tx
      .delete(superUserPermissionsSchema)
      .where(eq(superUserPermissionsSchema.userId, userId));

    if (permissionIds.length > 0) {
      await tx
        .insert(superUserPermissionsSchema)
        .values(
          permissionIds.map((permissionId) => ({ userId, permissionId }))
        );
    }

    await tx
      .update(superUsersSchema)
      .set({ tokenVersion: user.tokenVersion + 1 })
      .where(eq(superUsersSchema.id, userId));
  });
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteSuperUser(db: any, id: number) {
  // ── SUPERADMIN protection ────────────────────────────────────────────────
  // Check if the target user holds the SUPERADMIN role
  const adminRoleCheck = await db
    .select({ roleId: superUserRolesSchema.roleId })
    .from(superUserRolesSchema)
    .innerJoin(
      superRolesSchema,
      eq(superUserRolesSchema.roleId, superRolesSchema.id)
    )
    .where(
      and(
        eq(superUserRolesSchema.userId, id),
        eq(superRolesSchema.name, SuperRoleEnum.SUPERADMIN)
      )
    )
    .get();

  if (adminRoleCheck) {
    throw new Error(
      "The primary SUPERADMIN account cannot be deleted. " +
        "This account is protected to ensure the system always has an administrator."
    );
  }

  const [deleted] = await db
    .delete(superUsersSchema)
    .where(eq(superUsersSchema.id, id))
    .returning();
  if (!deleted) throw new Error("User not found");
  return deleted;
}
