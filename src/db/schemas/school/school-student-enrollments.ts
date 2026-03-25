import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { studentsSchema } from "./students";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolClassesSchema } from "./school-classes";
import { schoolSectionsSchema } from "./school-sections";
import { sql } from "drizzle-orm";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolsSchema } from "./schools";

export const schoolStudentEnrollmentsSchema = sqliteTable(
  "student_enrollments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: integer("student_id")
      .references(() => studentsSchema.userId, { onDelete: "cascade" })
      .notNull(),
    academicYearId: integer("academic_year_id")
      .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
      .notNull(),

    // classId: integer("class_id")
    //   .references(() => schoolClassesSchema.id)
    //   .notNull(),
    // sectionId: integer("section_id")
    //   .references(() => schoolSectionsSchema.id)
    //   .notNull(),

    // === Now references the real class-section entity ===
    classSectionId: integer("class_section_id")
      .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
      .notNull(),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    rollNumber: text("roll_number"), // unique per year + class + section (enforced in code)
    enrollmentDate: text("enrollment_date").default(sql`CURRENT_DATE`),
    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  }
);

// No constraint object — handle in code

export type SchoolStudentEnrollment =
  typeof schoolStudentEnrollmentsSchema.$inferSelect;
export type NewSchoolStudentEnrollment =
  typeof schoolStudentEnrollmentsSchema.$inferInsert;
