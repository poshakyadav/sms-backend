import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const superRolesSchema = sqliteTable(
  "roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    isSystem: integer("is_system", { mode: "boolean" })
      .default(false)
      .notNull(),
    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    uniqueRoleName: uniqueIndex("uq_super_role_name").on(table.name),
  })
);

export type SuperRole = typeof superRolesSchema.$inferSelect;
export type NewSuperRole = typeof superRolesSchema.$inferInsert;
