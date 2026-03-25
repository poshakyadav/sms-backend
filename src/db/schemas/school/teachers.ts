import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const teachersSchema = sqliteTable("teachers", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  qualification: text("qualification"),
  experienceYears: integer("experience_years"),
  joiningDate: text("joining_date"),
  specialization: text("specialization"),
});

export type Teacher = typeof teachersSchema.$inferSelect;
export type NewTeacher = typeof teachersSchema.$inferInsert;
