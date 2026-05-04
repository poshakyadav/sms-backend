import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { superRolesSchema } from "./super-roles";
import { superPermissionsSchema } from "./super-permissions";

export const superRolePermissionsSchema = sqliteTable(
  "role_permissions",
  {
    roleId: integer("role_id")
      .references(() => superRolesSchema.id, { onDelete: "cascade" })
      .notNull(),
    permissionId: integer("permission_id")
      .references(() => superPermissionsSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  })
);

export type SuperRolePermission =
  typeof superRolePermissionsSchema.$inferSelect;
export type NewSuperRolePermission =
  typeof superRolePermissionsSchema.$inferInsert;
