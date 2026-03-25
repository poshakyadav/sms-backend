import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users"; // Reference school users
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const schoolRefreshTokensSchema = sqliteTable("refresh_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  userId: integer("user_id")
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
    .notNull(),
  token: text("token").unique().notNull(),
  expiresAt: integer("expires_at").notNull(), // Unix timestamp
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolRefreshToken = typeof schoolRefreshTokensSchema.$inferSelect;
export type NewSchoolRefreshToken =
  typeof schoolRefreshTokensSchema.$inferInsert;
