import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SuperPermissionSlug } from "../../../types/super-permissions";

export const superPermissionsSchema = sqliteTable(
  "permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").$type<SuperPermissionSlug>().notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    module: text("module").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => ({
    uniqueSlug: uniqueIndex("uq_super_permission_slug").on(table.slug),
  })
);

export type SuperPermission = typeof superPermissionsSchema.$inferSelect;
export type NewSuperPermission = typeof superPermissionsSchema.$inferInsert;