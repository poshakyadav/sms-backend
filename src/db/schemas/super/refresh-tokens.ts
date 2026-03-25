import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { superUsersSchema } from "./super-users";

export const refreshTokensSchema = sqliteTable("refresh_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .references(() => superUsersSchema.id, { onDelete: "cascade" })
    .notNull(),
  token: text("token").unique().notNull(),
  expiresAt: integer("expires_at").notNull(), // Unix timestamp
});

export type RefreshToken = typeof refreshTokensSchema.$inferSelect;
export type NewRefreshToken = typeof refreshTokensSchema.$inferInsert;
