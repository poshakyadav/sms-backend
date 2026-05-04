import { integer, sqliteTable, primaryKey } from "drizzle-orm/sqlite-core";
import { schoolRolesSchema } from "./school-roles";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const schoolUserRolesSchema = sqliteTable(
  "user_roles",
  {
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    userId: integer("user_id")
      .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
      .notNull(),

    roleId: integer("role_id")
      .references(() => schoolRolesSchema.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
  })
);

export type SchoolUserRole = typeof schoolUserRolesSchema.$inferSelect;
export type NewSchoolUserRole = typeof schoolUserRolesSchema.$inferInsert;
