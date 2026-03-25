//  Teachers to Subjects/Classes

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { teachersSchema } from "./teachers";
import { schoolsSchema } from "./schools";
import { schoolClassSectionSubjectsSchema } from "./school-class-section-subjects";

export const schoolTeacherAssignmentsSchema = sqliteTable(
  "teacher_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),
    teacherId: integer("teacher_id")
      .references(() => teachersSchema.userId, { onDelete: "cascade" })
      .notNull(),
    classSubjectId: integer("class_subject_id")
      .references(() => schoolClassSectionSubjectsSchema.id, { onDelete: "cascade" })
      .notNull(),
    assignedDate: text("assigned_date")
      .default(sql`CURRENT_DATE`)
      .notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .default(false)
      .notNull(), // Main teacher for subject
  }
);

export type SchoolTeacherAssignment =
  typeof schoolTeacherAssignmentsSchema.$inferSelect;
export type NewSchoolTeacherAssignment =
  typeof schoolTeacherAssignmentsSchema.$inferInsert;
