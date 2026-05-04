import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { superUsersSchema } from "./super-users";
import { superRolesSchema } from "./super-roles";

export const superUserRolesSchema = sqliteTable(
  "user_roles",
  {
    userId: integer("user_id")
      .references(() => superUsersSchema.id, { onDelete: "cascade" })
      .notNull(),
    roleId: integer("role_id")
      .references(() => superRolesSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
  })
);

export type SuperUserRole = typeof superUserRolesSchema.$inferSelect;
export type NewSuperUserRole = typeof superUserRolesSchema.$inferInsert;
