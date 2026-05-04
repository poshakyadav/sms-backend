// …/school/permissions/sync-service.ts

import { eq } from "drizzle-orm";
import {
  schoolPermissionsSchema,
  schoolRolePermissionsSchema,
  schoolRolesSchema,
  schoolUserPermissionsSchema,
  schoolUserRolesSchema,
} from "../../../db/schemas/school";
import {
  ALL_PERMISSION_SLUGS,
  STAFF_PERMISSION_SLUGS,
  STUDENT_PERMISSION_SLUGS,
  PARENT_PERMISSION_SLUGS,
  PERMISSION_CATEGORY_MAP,
  SCHOOL_PERMISSIONS,
  WILDCARD_PERMISSION,
  PermissionSlugWithWildcard,
} from "../../../types/school-permissions";
import { SchoolRole } from "../../../types/school-role";
import { getSchoolDB } from "../../../db/school-client";
import { getCommonDB } from "../../../db";
import { schoolsSchema as superSchoolsSchema } from "../../../db/schemas/super";

// ─── Canonical role → permission map ─────────────────────────────────────────
//
// RULES enforced here (read before editing):
//
//   1. Staff roles ONLY receive slugs from STAFF_PERMISSION_SLUGS.
//      Never add a student/parent slug to a staff role.
//
//   2. STUDENT role ONLY receives slugs from STUDENT_PERMISSION_SLUGS.
//      No staff slugs — not even "dashboard.view".
//
//   3. STUDENT_PARENT role ONLY receives slugs from PARENT_PERMISSION_SLUGS.
//      No staff slugs. No student slugs.
//
//   4. SCHOOL_OWNER wildcard ('*') is a runtime signal only — it is NEVER
//      written as a row in role_permissions.
//
const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionSlugWithWildcard[]> = {
  [SchoolRole.SCHOOL_OWNER]: [...STAFF_PERMISSION_SLUGS, WILDCARD_PERMISSION],

  [SchoolRole.PRINCIPAL]: [
    "dashboard.view",
    "users.list",
    "users.edit",
    "students.list",
    "students.profile.manage",
    "students.bulk-upload",
    "academics.years.manage",
    "academics.classes.manage",
    "academics.sections.manage",
    "academics.enroll",
    "academics.unenroll",
    "academics.subjects.manage",
    "academics.assign-teacher",
    "academics.mappings.manage",
    "attendance.mark",
    "attendance.report",
    "fees.report",
    "fees.ledger.view",
    "exams.create",
    "exams.edit",
    "exams.marks.enter",
    "exams.admit-card",
    "exams.report-card",
    "assignments.create",
    "assignments.edit",
    "assignments.grade",
    "assignments.submissions.view",
    "notifications.send",
    "notifications.view",
    "roles.manage",
    "contact.submit",
  ],

  [SchoolRole.MANAGER]: [
    "dashboard.view",
    "users.list",
    "students.list",
    "fees.structures.manage",
    "fees.payments.record",
    "fees.report",
    "fees.ledger.view",
    "academics.years.manage",
    "academics.classes.manage",
    "academics.sections.manage",
    "notifications.send",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.ADMISSION_OFFICER]: [
    "dashboard.view",
    "users.list",
    "users.create",
    "students.list",
    "students.profile.manage",
    "students.bulk-upload",
    "academics.enroll",
    "academics.unenroll",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.TEACHER]: [
    "dashboard.view",
    "students.list",
    "attendance.mark",
    "attendance.report",
    "assignments.create",
    "assignments.edit",
    "assignments.grade",
    "assignments.submissions.view",
    "exams.marks.enter",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.ACCOUNTANT]: [
    "dashboard.view",
    "users.list",
    "students.list",
    "fees.structures.manage",
    "fees.payments.record",
    "fees.report",
    "fees.ledger.view",
    "contact.submit",
  ],

  [SchoolRole.LIBRARIAN]: [
    "dashboard.view",
    "students.list",
    "library.issue",
    "library.return",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.TRANSPORT_STAFF]: [
    "dashboard.view",
    "transport.manage",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.SECURITY_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.CANTEEN_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.SCHOOL_NURSE]: [
    "dashboard.view",
    "students.list",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.HOUSEKEEPING_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.MAINTENANCE_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.GROUNDS_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  [SchoolRole.UTILITY_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // STUDENT — only student-category slugs
  [SchoolRole.STUDENT]: [...STUDENT_PERMISSION_SLUGS],

  // STUDENT_PARENT — only parent-category slugs
  [SchoolRole.STUDENT_PARENT]: [...PARENT_PERMISSION_SLUGS],
};

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface SyncResult {
  schoolCode: string;
  permissionsAdded: number;
  permissionsUpdated: number; // category backfills on existing rows
  rolesAdded: number;
  roleLinksAdded: number;
  alreadyUpToDate: boolean;
  error?: string;
}

export interface ResetResult {
  schoolCode: string;
  // Rows wiped
  permissionsDeleted: number;
  rolesDeleted: number;
  roleLinksDeleted: number;
  userRoleLinksDeleted: number;
  userPermissionLinksDeleted: number;
  // Rows re-seeded
  permissionsInserted: number;
  rolesInserted: number;
  roleLinksInserted: number;
  error?: string;
}

// ─── Core sync function ───────────────────────────────────────────────────────

/**
 * IDEMPOTENT, NON-DESTRUCTIVE PERMISSION SYNC
 *
 * Run this whenever new permission slugs are added to school-permissions.ts
 * or DEFAULT_ROLE_PERMISSIONS above is updated.
 *
 * What it does:
 *   1. Inserts any permission slugs present in ALL_PERMISSION_SLUGS but missing
 *      from the school's permissions table (with correct name/module/category).
 *   2. Backfills the `category` column on existing rows whose stored category
 *      no longer matches PERMISSION_CATEGORY_MAP (migration path for old data).
 *   3. Inserts any SchoolRole enum values missing from the roles table.
 *   4. For each role, inserts missing role→permission links per
 *      DEFAULT_ROLE_PERMISSIONS.
 *
 * What it does NOT do:
 *   • Does not remove existing permissions, roles, or links.
 *   • Does not touch custom roles created by the school owner.
 *   • Does not modify user-role or user-permission assignments.
 *   • Safe to call as many times as needed — fully idempotent.
 */
export async function syncPermissionsAndRoles(
  env: any,
  schoolCode: string
): Promise<SyncResult> {
  const result: SyncResult = {
    schoolCode,
    permissionsAdded: 0,
    permissionsUpdated: 0,
    rolesAdded: 0,
    roleLinksAdded: 0,
    alreadyUpToDate: false,
  };

  try {
    const db = await getSchoolDB(env, schoolCode);

    // ── Step 1a: Insert missing permission slugs ──────────────────────────
    const existingPerms: { slug: string; category: string }[] = await db
      .select({
        slug: schoolPermissionsSchema.slug,
        category: schoolPermissionsSchema.category,
      })
      .from(schoolPermissionsSchema)
      .all();

    const existingPermMap = new Map(
      existingPerms.map((p) => [p.slug, p.category])
    );

    const missingSlugs = ALL_PERMISSION_SLUGS.filter(
      (slug) => !existingPermMap.has(slug)
    );

    if (missingSlugs.length > 0) {
      const newPermRows = missingSlugs.map((slug) => {
        let module = "GENERAL";
        for (const [modKey, modObj] of Object.entries(SCHOOL_PERMISSIONS)) {
          if (Object.values(modObj).includes(slug as any)) {
            module = modKey;
            break;
          }
        }
        const category = PERMISSION_CATEGORY_MAP[slug] ?? "staff";
        return {
          slug,
          name: slug
            .split(".")
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(" "),
          description: `Permission: ${slug}`,
          module,
          category,
        };
      });

      await db
        .insert(schoolPermissionsSchema)
        .values(newPermRows)
        .onConflictDoNothing();

      result.permissionsAdded = missingSlugs.length;
    }

    // ── Step 1b: Backfill category on existing rows with wrong category ───
    // Handles the migration from the old single-namespace system where
    // student/parent slugs were stored with category = 'staff'.
    let backfillCount = 0;
    for (const [slug, storedCategory] of existingPermMap.entries()) {
      const correctCategory =
        PERMISSION_CATEGORY_MAP[slug as keyof typeof PERMISSION_CATEGORY_MAP];
      if (correctCategory && storedCategory !== correctCategory) {
        await db
          .update(schoolPermissionsSchema)
          .set({ category: correctCategory })
          .where(eq(schoolPermissionsSchema.slug, slug as any));
        backfillCount++;
      }
    }
    result.permissionsUpdated = backfillCount;

    // ── Step 2: Insert missing system roles ───────────────────────────────
    const existingRoles: { name: string; id: number }[] = await db
      .select({ name: schoolRolesSchema.name, id: schoolRolesSchema.id })
      .from(schoolRolesSchema)
      .all();

    const existingRoleNames = new Set(existingRoles.map((r) => r.name));
    const missingRoleNames = Object.values(SchoolRole).filter(
      (r) => !existingRoleNames.has(r)
    );

    if (missingRoleNames.length > 0) {
      await db
        .insert(schoolRolesSchema)
        .values(
          missingRoleNames.map((name) => ({
            name,
            description: `System role: ${name}`,
            isSystem: true,
          }))
        )
        .onConflictDoNothing();

      result.rolesAdded = missingRoleNames.length;
    }

    // ── Step 3: Insert missing role→permission links ───────────────────────
    // Re-fetch after potential inserts above to get fresh IDs
    const allRoles: { name: string; id: number }[] = await db
      .select({ name: schoolRolesSchema.name, id: schoolRolesSchema.id })
      .from(schoolRolesSchema)
      .all();

    const allPerms: { slug: string; id: number }[] = await db
      .select({
        slug: schoolPermissionsSchema.slug,
        id: schoolPermissionsSchema.id,
      })
      .from(schoolPermissionsSchema)
      .all();

    const roleMap = new Map(allRoles.map((r) => [r.name, r.id]));
    const permMap = new Map(allPerms.map((p) => [p.slug, p.id]));

    const existingLinks: { roleId: number; permissionId: number }[] = await db
      .select({
        roleId: schoolRolePermissionsSchema.roleId,
        permissionId: schoolRolePermissionsSchema.permissionId,
      })
      .from(schoolRolePermissionsSchema)
      .all();

    const existingLinkSet = new Set(
      existingLinks.map((l) => `${l.roleId}:${l.permissionId}`)
    );

    const newLinks: { roleId: number; permissionId: number }[] = [];

    for (const [roleName, slugs] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const roleId = roleMap.get(roleName);
      if (!roleId) continue;

      for (const slug of slugs) {
        if (slug === WILDCARD_PERMISSION) continue;
        const permId = permMap.get(slug);
        if (!permId) continue;

        const key = `${roleId}:${permId}`;
        if (!existingLinkSet.has(key)) {
          newLinks.push({ roleId, permissionId: permId });
        }
      }
    }

    if (newLinks.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < newLinks.length; i += BATCH) {
        await db
          .insert(schoolRolePermissionsSchema)
          .values(newLinks.slice(i, i + BATCH))
          .onConflictDoNothing();
      }
      result.roleLinksAdded = newLinks.length;
    }

    result.alreadyUpToDate =
      result.permissionsAdded === 0 &&
      result.permissionsUpdated === 0 &&
      result.rolesAdded === 0 &&
      result.roleLinksAdded === 0;

    return result;
  } catch (err: any) {
    result.error = err?.message ?? "Unknown error";
    return result;
  }
}

// ─── DEVELOPMENT-ONLY: Hard reset + re-seed ──────────────────────────────────

/**
 * ⚠️  DEVELOPMENT-ONLY OPERATION — DESTRUCTIVE ⚠️
 *
 * Wipes and re-seeds the entire permission system for a single school.
 * Use this when the permission schema has changed significantly and an
 * additive sync cannot fix stale data (e.g. old slugs with wrong categories,
 * renamed slugs, structural refactors).
 *
 * Execution order (all inside a transaction):
 *   1. Delete all role_permissions links.
 *   2. Delete all user_permissions overrides (direct user grants).
 *   3. Delete all user_roles assignments.
 *   4. Delete all system roles (isSystem = true).
 *      Custom roles created by the school owner are also deleted — acceptable
 *      in development; owners must re-create them after a hard reset.
 *   5. Delete all permissions rows.
 *   6. Re-seed permissions, roles, and role→permission links from
 *      DEFAULT_ROLE_PERMISSIONS — identical to what seedPermissionsAndRoles does.
 *
 * ── User impact ──────────────────────────────────────────────────────────────
 * Because user_roles is cleared, every user loses their role assignment.
 * The school owner's account will have NO role until re-assigned.
 * This is intentional and expected in a development reset.
 * Do NOT expose this endpoint in production builds.
 */
export async function hardResetPermissions(
  env: any,
  schoolCode: string
): Promise<ResetResult> {
  const result: ResetResult = {
    schoolCode,
    permissionsDeleted: 0,
    rolesDeleted: 0,
    roleLinksDeleted: 0,
    userRoleLinksDeleted: 0,
    userPermissionLinksDeleted: 0,
    permissionsInserted: 0,
    rolesInserted: 0,
    roleLinksInserted: 0,
  };

  try {
    const db = await getSchoolDB(env, schoolCode);

    await db.transaction(async (tx: any) => {
      // ── Wipe in dependency order ────────────────────────────────────────

      // 1. role_permissions (depends on roles + permissions)
      const deletedLinks = await tx
        .delete(schoolRolePermissionsSchema)
        .returning({ id: schoolRolePermissionsSchema.roleId });
      result.roleLinksDeleted = deletedLinks.length;

      // 2. user_permissions (depends on users + permissions)
      const deletedUserPerms = await tx
        .delete(schoolUserPermissionsSchema)
        .returning({ id: schoolUserPermissionsSchema.userId });
      result.userPermissionLinksDeleted = deletedUserPerms.length;

      // 3. user_roles (depends on users + roles)
      const deletedUserRoles = await tx
        .delete(schoolUserRolesSchema)
        .returning({ id: schoolUserRolesSchema.userId });
      result.userRoleLinksDeleted = deletedUserRoles.length;

      // 4. roles
      const deletedRoles = await tx
        .delete(schoolRolesSchema)
        .returning({ id: schoolRolesSchema.id });
      result.rolesDeleted = deletedRoles.length;

      // 5. permissions (must come after role_permissions + user_permissions)
      const deletedPerms = await tx
        .delete(schoolPermissionsSchema)
        .returning({ id: schoolPermissionsSchema.id });
      result.permissionsDeleted = deletedPerms.length;

      // ── Re-seed permissions ─────────────────────────────────────────────
      const permissionRows = ALL_PERMISSION_SLUGS.map((slug) => {
        let module = "GENERAL";
        for (const [modKey, modObj] of Object.entries(SCHOOL_PERMISSIONS)) {
          if (Object.values(modObj).includes(slug as any)) {
            module = modKey;
            break;
          }
        }
        const category = PERMISSION_CATEGORY_MAP[slug] ?? "staff";
        return {
          slug,
          name: slug
            .split(".")
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join(" "),
          description: `Permission: ${slug}`,
          module,
          category,
        };
      });

      await tx
        .insert(schoolPermissionsSchema)
        .values(permissionRows)
        .onConflictDoNothing();
      result.permissionsInserted = permissionRows.length;

      // ── Re-seed roles ───────────────────────────────────────────────────
      const roleRows = Object.values(SchoolRole).map((name) => ({
        name,
        description: `System role: ${name}`,
        isSystem: true,
      }));

      await tx.insert(schoolRolesSchema).values(roleRows).onConflictDoNothing();
      result.rolesInserted = roleRows.length;

      // ── Re-seed role→permission links ───────────────────────────────────
      // Re-fetch fresh IDs from within the transaction
      const freshRoles: { name: string; id: number }[] = await tx
        .select({ name: schoolRolesSchema.name, id: schoolRolesSchema.id })
        .from(schoolRolesSchema)
        .all();

      const freshPerms: { slug: string; id: number }[] = await tx
        .select({
          slug: schoolPermissionsSchema.slug,
          id: schoolPermissionsSchema.id,
        })
        .from(schoolPermissionsSchema)
        .all();

      const roleMap = new Map(freshRoles.map((r) => [r.name, r.id]));
      const permMap = new Map(freshPerms.map((p) => [p.slug, p.id]));

      const linkRows: { roleId: number; permissionId: number }[] = [];

      for (const [roleName, slugs] of Object.entries(
        DEFAULT_ROLE_PERMISSIONS
      )) {
        const roleId = roleMap.get(roleName);
        if (!roleId) continue;

        for (const slug of slugs) {
          if (slug === WILDCARD_PERMISSION) continue;
          const permId = permMap.get(slug);
          if (!permId) continue;
          linkRows.push({ roleId, permissionId: permId });
        }
      }

      if (linkRows.length > 0) {
        const BATCH = 100;
        for (let i = 0; i < linkRows.length; i += BATCH) {
          await tx
            .insert(schoolRolePermissionsSchema)
            .values(linkRows.slice(i, i + BATCH))
            .onConflictDoNothing();
        }
        result.roleLinksInserted = linkRows.length;
      }
    });

    return result;
  } catch (err: any) {
    result.error = err?.message ?? "Unknown error";
    return result;
  }
}

// ─── Sync ALL active schools ──────────────────────────────────────────────────

/**
 * Iterates every active school and calls syncPermissionsAndRoles.
 * Partial failures do not abort the batch — each school's result is collected.
 * Runs sequentially to avoid hammering Turso with concurrent connections.
 */
export async function syncAllSchools(env: any): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: SyncResult[];
}> {
  const commonDb = getCommonDB(env);

  const activeSchools: { uniqueCode: string }[] = await commonDb
    .select({ uniqueCode: superSchoolsSchema.uniqueCode })
    .from(superSchoolsSchema)
    .where(eq(superSchoolsSchema.isActive, true))
    .all();

  const results: SyncResult[] = [];

  for (const school of activeSchools) {
    const r = await syncPermissionsAndRoles(env, school.uniqueCode);
    results.push(r);
  }

  return {
    total: results.length,
    succeeded: results.filter((r) => !r.error).length,
    failed: results.filter((r) => !!r.error).length,
    results,
  };
}
