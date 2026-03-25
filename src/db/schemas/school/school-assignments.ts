import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolTeacherAssignmentsSchema } from "./school-teacher-assignments";
import { schoolUsersSchema } from "./school-users";
import { schoolSectionsSchema } from "./school-sections";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolsSchema } from "./schools";

export const schoolAssignmentsSchema = sqliteTable("assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  teacherAssignmentId: integer("teacher_assignment_id")
    .references(() => schoolTeacherAssignmentsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(), // Ties to teacher/class/subject

  // sectionId: integer("section_id") // Target specific section
  //   .references(() => schoolSectionsSchema.id, { onDelete: "cascade" })
  //   .notNull(),

  // === Now targets a real class-section ===
  classSectionId: integer("class_section_id")
    .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
    .notNull(),

  type: text("type").notNull(), // "CLASS_WORK", "HOME_WORK", "ASSIGNMENT"
  title: text("title").notNull(),
  description: text("description").notNull(),
  dueDate: text("due_date"), // "2026-02-20"
  targetDate: text("target_date"),
  maxMarks: integer("max_marks"),
  isMandatory: integer("is_mandatory", { mode: "boolean" })
    .default(true)
    .notNull(),
  enteredBy: integer("entered_by")
    .references(() => schoolUsersSchema.id)
    .notNull(), // Teacher ID
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolAssignment = typeof schoolAssignmentsSchema.$inferSelect;
export type NewSchoolAssignment = typeof schoolAssignmentsSchema.$inferInsert;
