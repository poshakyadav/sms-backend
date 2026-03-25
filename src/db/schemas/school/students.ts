import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const studentsSchema = sqliteTable("students", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  rollNumber: text("roll_number"), // unique per year + class + section (enforced in code)
  admissionDate: text("admission_date"),
  previousSchool: text("previous_school"),
  medicalInfo: text("medical_info"),
});

export type Student = typeof studentsSchema.$inferSelect;
export type NewStudent = typeof studentsSchema.$inferInsert;
