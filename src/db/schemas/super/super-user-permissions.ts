import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { superUsersSchema } from "./super-users";
import { superPermissionsSchema } from "./super-permissions";

export const superUserPermissionsSchema = sqliteTable(
  "user_permissions",
  {
    userId: integer("user_id")
      .references(() => superUsersSchema.id, { onDelete: "cascade" })
      .notNull(),
    permissionId: integer("permission_id")
      .references(() => superPermissionsSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.permissionId] }),
  })
);

export type SuperUserPermission =
  typeof superUserPermissionsSchema.$inferSelect;
export type NewSuperUserPermission =
  typeof superUserPermissionsSchema.$inferInsert;
