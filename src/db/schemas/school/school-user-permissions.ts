import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolPermissionsSchema } from "./school-permissions";
import { schoolsSchema } from "./schools";

/**
 * INDIVIDUAL USER PERMISSION OVERRIDES
 *
 * Allows assigning extra permissions to specific users
 * without creating a new role.
 *
 * Example: "Senior Teacher John" needs users.edit permission
 * but we don't want to give it to all teachers.
 */
export const schoolUserPermissionsSchema = sqliteTable(
  "user_permissions",
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

export type SchoolUserPermission =
  typeof schoolUserPermissionsSchema.$inferSelect;
export type NewSchoolUserPermission =
  typeof schoolUserPermissionsSchema.$inferInsert;
