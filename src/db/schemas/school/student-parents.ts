// Junction table – Many-to-Many
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { studentsSchema } from "./students";
import { parentsSchema } from "./parents";
import { schoolsSchema } from "./schools";

export const studentParentsSchema = sqliteTable("student_parents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  studentId: integer("student_id")
    .notNull()
    .references(() => studentsSchema.userId, { onDelete: "cascade" }),
  parentId: integer("parent_id")
    .notNull()
    .references(() => parentsSchema.userId, { onDelete: "cascade" }),
  relationship: text("relationship").notNull(), // "Father", "Mother", "Guardian"
  isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
});

export type StudentParent = typeof studentParentsSchema.$inferSelect;
export type NewStudentParent = typeof studentParentsSchema.$inferInsert;
