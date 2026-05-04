import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolExamsSchema } from "./school-exams";
import { schoolClassSectionSubjectsSchema } from "./school-class-section-subjects";

export const schoolExamSubjectsSchema = sqliteTable("exam_subjects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  examId: integer("exam_id")
    .references(() => schoolExamsSchema.id, { onDelete: "cascade" })
    .notNull(),
  classSubjectId: integer("class_subject_id")
    .references(() => schoolClassSectionSubjectsSchema.id, { onDelete: "cascade" })
    .notNull(),
  date: text("date").notNull(), // "2026-06-15"
  startTime: text("start_time"), // "09:00"
  endTime: text("end_time"), // "11:00"
  roomNumber: text("room_number"),
  maxMarks: integer("max_marks").notNull(),
  passingMarks: integer("passing_marks"),
  /**
   * OPTIONAL CUSTOM SUBJECT LABEL
   *
   * Overrides the subject name for this specific exam slot.
   * Used when the same subject has multiple papers, e.g.:
   *   - "English Paper One"
   *   - "English Paper Two"
   *   - "Mathematics Theory"
   *   - "Mathematics Practical"
   *
   * If NULL / empty, the timetable display falls back to the
   * canonical subject name from the subjects table.
   * This avoids creating duplicate subject records just for
   * exam-paper labelling.
   */
  subjectLabel: text("subject_label"), // e.g. "English Paper One" — optional override
});

export type SchoolExamSubject = typeof schoolExamSubjectsSchema.$inferSelect;
export type NewSchoolExamSubject = typeof schoolExamSubjectsSchema.$inferInsert;