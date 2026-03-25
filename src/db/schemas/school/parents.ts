// parents.ts (for STUDENT_PARENT)
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const parentsSchema = sqliteTable("parents", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  occupation: text("occupation"),
  address: text("address"),
});

export type Parent = typeof parentsSchema.$inferSelect;
export type NewParent = typeof parentsSchema.$inferInsert;
