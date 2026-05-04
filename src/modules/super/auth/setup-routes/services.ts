import { eq } from "drizzle-orm";
import {
  superRolesSchema,
  superUserRolesSchema,
  superUsersSchema,
} from "../../../../db";
import { seedSuperPermissionsAndRoles } from "../../permissions/services";
import { hashPassword } from "../../../../utils/hashing";
import { SuperRoleEnum } from "../../../../types/super-role";

/**
 * Returns true if the super_users table is empty (setup not yet done).
 */
export async function checkSetupRequired(db: any): Promise<boolean> {
  const existing = await db
    .select({ id: superUsersSchema.id })
    .from(superUsersSchema)
    .limit(1)
    .all();
  return existing.length === 0;
}

/**
 * Creates the one-and-only primary SUPERADMIN.
 * Throws if any user already exists (double-check guard).
 */
export async function bootstrapSuperAdmin(
  db: any,
  data: { name: string; email: string; password: string }
) {
  // Ensure roles + permissions exist
  await seedSuperPermissionsAndRoles(db);

  // Double-check — race condition guard
  const setupRequired = await checkSetupRequired(db);
  if (!setupRequired) {
    throw new Error("Super admin already exists. Setup is complete.");
  }

  const passwordHash = await hashPassword(data.password);

  return db.transaction(async (tx: any) => {
    // Create the user
    const [newUser] = await tx
      .insert(superUsersSchema)
      .values({
        name: data.name,
        email: data.email,
        passwordHash,
        tokenVersion: 0,
        isActive: true,
      })
      .returning();

    // Find the SUPERADMIN role
    const adminRole = await tx
      .select({ id: superRolesSchema.id })
      .from(superRolesSchema)
      .where(eq(superRolesSchema.name, SuperRoleEnum.SUPERADMIN))
      .get();

    if (!adminRole) {
      throw new Error("SUPERADMIN role not found after seeding. Check seeder.");
    }

    // Assign SUPERADMIN role
    await tx
      .insert(superUserRolesSchema)
      .values({ userId: newUser.id, roleId: adminRole.id });

    return newUser;
  });
}
