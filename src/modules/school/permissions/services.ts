// .../school/permissions/services.ts

import { sql } from "drizzle-orm";
import { SchoolEnv } from "../../../types/common-types";
import { getSchoolDB } from "../../../db/school-client";
import {
  schoolPermissionsSchema,
  schoolRolePermissionsSchema,
  schoolRolesSchema,
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
  PermissionCategory,
} from "../../../types/school-permissions";
import { SchoolRole } from "../../../types/school-role";

// ─── Canonical role → permission map ─────────────────────────────────────────
//
// RULES enforced here (read before editing):
//
//   1. Staff roles (PRINCIPAL, TEACHER, ACCOUNTANT …) ONLY receive slugs from
//      STAFF_PERMISSION_SLUGS. Never add a student/parent slug to a staff role.
//
//   2. STUDENT role ONLY receives slugs from STUDENT_PERMISSION_SLUGS.
//      No staff slugs — not even "dashboard.view".
//      The student landing page is gated by "dashboard.student.view" instead.
//
//   3. STUDENT_PARENT role ONLY receives slugs from PARENT_PERMISSION_SLUGS.
//      No staff slugs. No student slugs.
//      The parent landing page is gated by "dashboard.parent.view" instead.
//
//   4. SCHOOL_OWNER wildcard ('*') is a runtime signal only — it is NEVER
//      written as a row in role_permissions. The DB query in
//      getUserPermissionsFromDB returns it alongside all 'staff' category slugs.
//
const DEFAULT_ROLE_PERMISSIONS: Record<string, PermissionSlugWithWildcard[]> = {
  // ── SCHOOL_OWNER ──────────────────────────────────────────────────────────
  // All staff slugs are listed so role_permissions rows exist for each one.
  // The wildcard is injected at query time — not stored in the DB.
  [SchoolRole.SCHOOL_OWNER]: [...STAFF_PERMISSION_SLUGS, WILDCARD_PERMISSION],

  // ── PRINCIPAL ─────────────────────────────────────────────────────────────
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
    "exams.admit-card.publish",
    "exams.report-card.publish",
    "assignments.create",
    "assignments.edit",
    "assignments.grade",
    "assignments.submissions.view",
    "notifications.send",
    "notifications.view",
    "roles.manage",
    "contact.submit",
  ],

  // ── MANAGER ───────────────────────────────────────────────────────────────
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

  // ── ADMISSION_OFFICER ─────────────────────────────────────────────────────
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

  // ── TEACHER ───────────────────────────────────────────────────────────────
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

  // ── ACCOUNTANT ────────────────────────────────────────────────────────────
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

  // ── LIBRARIAN ─────────────────────────────────────────────────────────────
  [SchoolRole.LIBRARIAN]: [
    "dashboard.view",
    "students.list",
    "library.issue",
    "library.return",
    "notifications.view",
    "contact.submit",
  ],

  // ── TRANSPORT_STAFF ───────────────────────────────────────────────────────
  [SchoolRole.TRANSPORT_STAFF]: [
    "dashboard.view",
    "transport.manage",
    "notifications.view",
    "contact.submit",
  ],

  // ── SECURITY_STAFF ────────────────────────────────────────────────────────
  [SchoolRole.SECURITY_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── CANTEEN_STAFF ─────────────────────────────────────────────────────────
  [SchoolRole.CANTEEN_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── SCHOOL_NURSE ──────────────────────────────────────────────────────────
  [SchoolRole.SCHOOL_NURSE]: [
    "dashboard.view",
    "students.list",
    "notifications.view",
    "contact.submit",
  ],

  // ── HOUSEKEEPING_STAFF ────────────────────────────────────────────────────
  [SchoolRole.HOUSEKEEPING_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── MAINTENANCE_STAFF ─────────────────────────────────────────────────────
  [SchoolRole.MAINTENANCE_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── GROUNDS_STAFF ─────────────────────────────────────────────────────────
  [SchoolRole.GROUNDS_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── UTILITY_STAFF ─────────────────────────────────────────────────────────
  [SchoolRole.UTILITY_STAFF]: [
    "dashboard.view",
    "notifications.view",
    "contact.submit",
  ],

  // ── STUDENT ───────────────────────────────────────────────────────────────
  // ONLY student-category slugs. No staff slugs whatsoever.
  // "dashboard.student.view" gates the student landing page component —
  // a completely separate route from the staff /school/dashboard.
  [SchoolRole.STUDENT]: [...STUDENT_PERMISSION_SLUGS],

  // ── STUDENT_PARENT ────────────────────────────────────────────────────────
  // ONLY parent-category slugs. No staff slugs. No student slugs.
  // "dashboard.parent.view" gates the parent landing page component.
  // All parent API routes read X-Active-Child-Id (set by auth-interceptor.ts)
  // to scope data to the currently selected child — no studentId in URL needed.
  [SchoolRole.STUDENT_PARENT]: [...PARENT_PERMISSION_SLUGS],
};

// ─── Role → Category mapping ──────────────────────────────────────────────────
// UPDATED: Explicit category per system role.
// This is the source of truth written to the `roles.category` column during seeding.
const SYSTEM_ROLE_CATEGORIES: Record<string, PermissionCategory> = {
  [SchoolRole.SCHOOL_OWNER]: "staff",
  [SchoolRole.PRINCIPAL]: "staff",
  [SchoolRole.MANAGER]: "staff",
  [SchoolRole.ADMISSION_OFFICER]: "staff",
  [SchoolRole.TEACHER]: "staff",
  [SchoolRole.ACCOUNTANT]: "staff",
  [SchoolRole.LIBRARIAN]: "staff",
  [SchoolRole.TRANSPORT_STAFF]: "staff",
  [SchoolRole.SECURITY_STAFF]: "staff",
  [SchoolRole.CANTEEN_STAFF]: "staff",
  [SchoolRole.SCHOOL_NURSE]: "staff",
  [SchoolRole.HOUSEKEEPING_STAFF]: "staff",
  [SchoolRole.MAINTENANCE_STAFF]: "staff",
  [SchoolRole.GROUNDS_STAFF]: "staff",
  [SchoolRole.UTILITY_STAFF]: "staff",
  [SchoolRole.STUDENT]: "student",
  [SchoolRole.STUDENT_PARENT]: "parent",
};

// ─── Seeder ───────────────────────────────────────────────────────────────────

/**
 * PRODUCTION-GRADE SEEDER (UPDATED)
 *
 * Runs once per school during provisioning. Completely idempotent.
 *
 * Changes vs original:
 *   - System roles are now inserted with the correct `category` from
 *     SYSTEM_ROLE_CATEGORIES above.
 *   - Custom roles default to 'staff' via the column default (no change needed).
 *   - All other logic is identical to the original seeder.
 */
export async function seedPermissionsAndRoles(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Guard: skip if already seeded ────────────────────────────────────────
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schoolPermissionsSchema);

  if (count > 0) {
    console.log(
      `✅ Permissions already seeded for school ${schoolCode} — skipping`
    );
    return;
  }

  console.log(`🌱 Seeding permissions and roles for school ${schoolCode}…`);

  // ── Step 1: Insert all permission slugs with category ────────────────────
  const permissionInserts = ALL_PERMISSION_SLUGS.map((slug) => {
    let module = "GENERAL";
    for (const [modKey, modObj] of Object.entries(SCHOOL_PERMISSIONS)) {
      if (Object.values(modObj).includes(slug as any)) {
        module = modKey;
        break;
      }
    }

    const category = PERMISSION_CATEGORY_MAP[slug];

    return {
      slug,
      name: slug
        .split(".")
        .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      description: `Permission: ${slug}`,
      module,
      category,
    };
  });

  await db
    .insert(schoolPermissionsSchema)
    .values(permissionInserts)
    .onConflictDoNothing();

  console.log(`✅ Inserted ${permissionInserts.length} permissions`);

  // ── Step 2: Insert all system roles WITH their category ──────────────────
  // UPDATED: Now writes `category` for each system role.
  const roleInserts = Object.values(SchoolRole).map((roleName) => ({
    name: roleName,
    description: `System role: ${roleName}`,
    isSystem: true,
    category: SYSTEM_ROLE_CATEGORIES[roleName] ?? "staff", // safe fallback
  }));

  await db.insert(schoolRolesSchema).values(roleInserts).onConflictDoNothing();

  console.log(`✅ Inserted ${roleInserts.length} system roles`);

  // ── Step 3: Build role → permission links ─────────────────────────────────
  const allRoles = await db.select().from(schoolRolesSchema);
  const allPermissions = await db.select().from(schoolPermissionsSchema);

  const roleMap = new Map(allRoles.map((r: any) => [r.name, r.id]));
  const permissionMap = new Map(allPermissions.map((p: any) => [p.slug, p.id]));

  const rolePermissionInserts: { roleId: number; permissionId: number }[] = [];

  for (const [roleName, slugs] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleMap.get(roleName);
    if (!roleId) continue;

    for (const slug of slugs) {
      if (slug === WILDCARD_PERMISSION) continue;

      const permId = permissionMap.get(slug);
      if (!permId) {
        console.warn(
          `⚠️ Slug "${slug}" in DEFAULT_ROLE_PERMISSIONS[${roleName}] not found in permissions table — skipping`
        );
        continue;
      }

      rolePermissionInserts.push({ roleId, permissionId: permId });
    }
  }

  if (rolePermissionInserts.length > 0) {
    await db
      .insert(schoolRolePermissionsSchema)
      .values(rolePermissionInserts)
      .onConflictDoNothing();

    console.log(
      `✅ Assigned ${rolePermissionInserts.length} role-permission links`
    );
  }

  console.log(`🎉 Seeding completed for school ${schoolCode}`);
}
