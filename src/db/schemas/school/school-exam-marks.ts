import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { schoolExamsSchema } from "./school-exams";
import { schoolClassSectionSubjectsSchema } from "./school-class-section-subjects";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolUsersSchema } from "./school-users";
import { sql } from "drizzle-orm";

export const schoolExamMarksSchema = sqliteTable("exam_marks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  examId: integer("exam_id")
    .references(() => schoolExamsSchema.id, { onDelete: "cascade" })
    .notNull(),
  // === NEW: per subject inside the exam event ===
  classSubjectId: integer("class_subject_id")
    .references(() => schoolClassSectionSubjectsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(),
  enrollmentId: integer("enrollment_id")
    .references(() => schoolStudentEnrollmentsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(),
  marksObtained: integer("marks_obtained").notNull(),
  grade: text("grade"),
  remarks: text("remarks"),
  enteredBy: integer("entered_by")
    .references(() => schoolUsersSchema.id)
    .notNull(),
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolExamMark = typeof schoolExamMarksSchema.$inferSelect;
export type NewSchoolExamMark = typeof schoolExamMarksSchema.$inferInsert;
