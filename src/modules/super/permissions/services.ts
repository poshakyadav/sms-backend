import { sql } from "drizzle-orm";
import {
  superPermissionsSchema,
  superRolePermissionsSchema,
  superRolesSchema,
} from "../../../db/schemas/super";
import {
  ALL_SUPER_PERMISSION_SLUGS,
  DEFAULT_ROLE_PERMISSIONS,
  SUPER_PERMISSIONS,
} from "../../../types/super-permissions";
import { SuperRoleEnum } from "../../../types/super-role";

/**
 * One-time seeder — idempotent, safe to call multiple times.
 * Run once on first deploy / common-DB migration.
 */
export async function seedSuperPermissionsAndRoles(db: any): Promise<void> {
  // Check if already seeded
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(superPermissionsSchema);

  if (count > 0) {
    console.log("✅ Super permissions already seeded — skipping.");
    return;
  }

  console.log("🌱 Seeding super permissions and roles...");

  // 1. Insert all atomic permissions
  const permissionInserts = ALL_SUPER_PERMISSION_SLUGS.map((slug) => {
    let module = "GENERAL";
    for (const [modKey, modObj] of Object.entries(SUPER_PERMISSIONS)) {
      if (Object.values(modObj).includes(slug as any)) {
        module = modKey;
        break;
      }
    }
    return {
      slug,
      name: slug
        .split(".")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" "),
      description: `Permission to ${slug.replace(".", " ")}`,
      module,
    };
  });

  await db
    .insert(superPermissionsSchema)
    .values(permissionInserts)
    .onConflictDoNothing();
  console.log(`✅ Inserted ${permissionInserts.length} permissions`);

  // 2. Insert system roles
  const roleInserts = Object.values(SuperRoleEnum).map((name) => ({
    name,
    description: `System role: ${name}`,
    isSystem: true,
  }));

  await db.insert(superRolesSchema).values(roleInserts).onConflictDoNothing();
  console.log(`✅ Inserted ${roleInserts.length} system roles`);

  // 3. Resolve IDs — explicit Map types so .get() returns number | undefined
  const allRoles: { name: string; id: number }[] = await db
    .select({ name: superRolesSchema.name, id: superRolesSchema.id })
    .from(superRolesSchema);

  const allPermissions: { slug: string; id: number }[] = await db
    .select({
      slug: superPermissionsSchema.slug,
      id: superPermissionsSchema.id,
    })
    .from(superPermissionsSchema);

  const roleMap = new Map<string, number>(allRoles.map((r) => [r.name, r.id]));
  const permissionMap = new Map<string, number>(
    allPermissions.map((p) => [p.slug, p.id])
  );

  // 4. Assign default permissions per role
  const links: { roleId: number; permissionId: number }[] = [];

  for (const [roleName, slugs] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleMap.get(roleName);
    if (!roleId) continue; // narrow: roleId is now number

    for (const slug of slugs) {
      const permId = permissionMap.get(slug);
      if (!permId) continue; // narrow: permId is now number

      // Both are narrowed to number here — no type error
      links.push({ roleId: roleId, permissionId: permId });
    }
  }

  if (links.length > 0) {
    await db
      .insert(superRolePermissionsSchema)
      .values(links)
      .onConflictDoNothing();
    console.log(`✅ Assigned ${links.length} role-permission links`);
  }

  console.log("🎉 Super seeding complete.");
}
