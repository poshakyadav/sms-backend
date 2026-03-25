// src/modules/permissions/services.ts
import { userPermissionsSchema } from '../../../db';
import { eq, and } from 'drizzle-orm';
import { Permission } from '../../../types/permissions';

export async function updateUserPermission(db: any, userId: number, permission: Permission, allowed: boolean) {
  const existing = await db.select().from(userPermissionsSchema)
    .where(and(eq(userPermissionsSchema.userId, userId), eq(userPermissionsSchema.permission, permission)))
    .get();

  if (existing) {
    await db.update(userPermissionsSchema)
      .set({ allowed })
      .where(eq(userPermissionsSchema.id, existing.id));
  } else {
    await db.insert(userPermissionsSchema)
      .values({ userId, permission, allowed });
  }
}

export async function getUserPermissions(db: any, userId: number) {
  return db.select().from(userPermissionsSchema).where(eq(userPermissionsSchema.userId, userId)).all();
}