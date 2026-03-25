import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tursoDatabasesSchema = sqliteTable("turso_databases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  authToken: text("auth_token").notNull(),
  isAssigned: integer("is_assigned", { mode: "boolean" }).notNull().default(false),
  // NEW: Track last successful migration
  lastMigrationAt: text("last_migration_at").default(sql`CURRENT_TIMESTAMP`),
  // NEW: Who created this entry / using which mail turso db is created (useful for management/auditing)
  createdByEmail: text("created_by_email").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type TursoDatabase = typeof tursoDatabasesSchema.$inferSelect;
export type NewTursoDatabase = typeof tursoDatabasesSchema.$inferInsert;