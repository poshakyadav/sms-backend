import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { studentsSchema } from "./students";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolClassesSchema } from "./school-classes";
import { schoolSectionsSchema } from "./school-sections";
import { sql } from "drizzle-orm";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";

export const schoolStudentEnrollmentsSchema = sqliteTable(
  "student_enrollments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),
    studentId: integer("student_id")
      .references(() => studentsSchema.userId, { onDelete: "cascade" })
      .notNull(),
    academicYearId: integer("academic_year_id")
      .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
      .notNull(),

    // === Now references the real class-section entity ===
    classSectionId: integer("class_section_id")
      .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
      .notNull(),

    rollNumber: text("roll_number"), // unique per year + class + section (enforced in code)
    enrollmentDate: text("enrollment_date").default(sql`CURRENT_DATE`),
    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),

    // ── UNENROLLMENT AUDIT FIELDS (production-grade) ──────────────────────
    // These are NULL while the student is actively enrolled.
    // They get populated atomically in the unenrollStudentFromClassSection transaction.

    /**
     * Type of unenrollment:
     *   "TEMPORARY"      - Student is on leave; may be re-enrolled later in same year
     *   "PERMANENT"      - Student is leaving the school; account will be deactivated
     *   "TRANSFERRED_OUT"- Student is moving to another class/section (used by moveStudent)
     *
     * NULL = student is currently enrolled (not unenrolled)
     */
    unenrollmentType: text("unenrollment_type"), // "TEMPORARY" | "PERMANENT" | "TRANSFERRED_OUT" | null

    /**
     * Mandatory reason text captured from the admin at the time of unenrollment.
     * This is used for audit trails, TC generation, and historical reporting.
     */
    unenrollmentReason: text("unenrollment_reason"), // free text, required when unenrolling

    /**
     * ISO timestamp of when the unenrollment was performed.
     * Stored as text (consistent with rest of schema).
     */
    unenrolledAt: text("unenrolled_at"), // ISO timestamp e.g. "2026-04-22T10:30:00.000Z"

    /**
     * FK to school_users.id — the admin/staff who performed the unenrollment.
     * Used for accountability and audit logs.
     */
    unenrolledBy: integer("unenrolled_by").references(
      () => schoolUsersSchema.id
    ), // FK to school_users
  }
);

// No constraint object — handle in code

export type SchoolStudentEnrollment =
  typeof schoolStudentEnrollmentsSchema.$inferSelect;
export type NewSchoolStudentEnrollment =
  typeof schoolStudentEnrollmentsSchema.$inferInsert;

// ── Unenrollment type constants (use these instead of raw strings) ─────────
export const UnenrollmentType = {
  TEMPORARY: "TEMPORARY",
  PERMANENT: "PERMANENT",
  TRANSFERRED_OUT: "TRANSFERRED_OUT",
} as const;

export type UnenrollmentTypeValue =
  (typeof UnenrollmentType)[keyof typeof UnenrollmentType];
