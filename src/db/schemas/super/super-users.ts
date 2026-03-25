import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SuperRole } from "../../../types/super-role";
import { sql } from "drizzle-orm";

export const superUsersSchema = sqliteTable("super_users",{
    id: integer("id").primaryKey({autoIncrement: true}),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().$type<SuperRole>().default(SuperRole.SUPERUSER),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),

});

export type SuperUsers = typeof superUsersSchema.$inferSelect;
export type NewSuperUser = typeof superUsersSchema.$inferInsert;