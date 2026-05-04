import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const superUsersSchema = sqliteTable("super_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),

  // tokenVersion allows instant token invalidation when roles/permissions change.
  // Old JWTs carrying a lower version are rejected at the validation middleware.
  tokenVersion: integer("token_version").default(0).notNull(),

  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SuperUsers = typeof superUsersSchema.$inferSelect;
export type NewSuperUser = typeof superUsersSchema.$inferInsert;
