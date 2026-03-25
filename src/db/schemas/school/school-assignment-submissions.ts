import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolAssignmentsSchema } from "./school-assignments";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolUsersSchema } from "./school-users";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

// Submissions/Marks (per student)
export const schoolAssignmentSubmissionsSchema = sqliteTable(
  "assignment_submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),
    assignmentId: integer("assignment_id")
      .references(() => schoolAssignmentsSchema.id, { onDelete: "cascade" })
      .notNull(),
    enrollmentId: integer("enrollment_id")
      .references(() => schoolStudentEnrollmentsSchema.id, {
        onDelete: "cascade",
      })
      .notNull(),

    // DUAL STATUS (only for ASSIGNMENT)
    studentStatus: text("student_status").default("PENDING").notNull(), // PENDING | MARKED_AS_DONE
    teacherStatus: text("teacher_status").default("NOT_RECEIVED").notNull(), // NOT_RECEIVED | RECEIVED | GRADED
    receivedAt: text("received_at"), // When teacher physically collected it

    // Grading fields
    marksObtained: integer("marks_obtained"),
    remarks: text("remarks"),
    enteredBy: integer("entered_by")
      .references(() => schoolUsersSchema.id)
      .notNull(), // Teacher ID
    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type SchoolAssignmentSubmission =
  typeof schoolAssignmentSubmissionsSchema.$inferSelect;
export type NewSchoolAssignmentSubmission =
  typeof schoolAssignmentSubmissionsSchema.$inferInsert;
