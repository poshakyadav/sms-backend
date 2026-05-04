import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { schoolRolesSchema } from "./school-roles";
import { schoolPermissionsSchema } from "./school-permissions";
import { schoolsSchema } from "./schools";

export const schoolRolePermissionsSchema = sqliteTable(
  "role_permissions",
  {
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    roleId: integer("role_id")
      .references(() => schoolRolesSchema.id, { onDelete: "cascade" })
      .notNull(),

    permissionId: integer("permission_id")
      .references(() => schoolPermissionsSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    // Composite PK prevents duplicates
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  })
);

export type SchoolRolePermission =
  typeof schoolRolePermissionsSchema.$inferSelect;
export type NewSchoolRolePermission =
  typeof schoolRolePermissionsSchema.$inferInsert;
