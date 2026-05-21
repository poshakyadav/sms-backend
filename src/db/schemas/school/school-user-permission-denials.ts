// src/db/schemas/school/school-user-permission-denials.ts

import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolPermissionsSchema } from "./school-permissions";
import { schoolsSchema } from "./schools";

/**
 * USER PERMISSION DENIALS (REVOCATIONS)
 *
 * Allows explicitly revoking a permission that a user would otherwise
 * inherit through their assigned roles.
 *
 * Use case: A STUDENT_PARENT user inherits `exams.parent.admit-card`
 * from the STUDENT_PARENT role, but you want to block it for one specific
 * parent. Insert a row here — the permission resolver checks this table
 * and removes the slug from the effective permission set.
 *
 * Resolution order (highest priority last wins):
 *   1. Role-inherited permissions (from role_permissions)
 *   2. Direct grants (user_permissions)          ← adds slugs
 *   3. Denials (user_permission_denials)          ← removes slugs (HIGHEST PRIORITY)
 *
 * A denial always wins — even if a permission appears in both
 * user_permissions and user_permission_denials, the denial takes effect.
 */
export const schoolUserPermissionDenialsSchema = sqliteTable(
  "user_permission_denials",
  {
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    userId: integer("user_id")
      .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
      .notNull(),

    permissionId: integer("permission_id")
      .references(() => schoolPermissionsSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.permissionId] }),
  })
);

export type SchoolUserPermissionDenial =
  typeof schoolUserPermissionDenialsSchema.$inferSelect;
export type NewSchoolUserPermissionDenial =
  typeof schoolUserPermissionDenialsSchema.$inferInsert;
