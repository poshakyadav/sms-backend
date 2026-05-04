import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolsSchema } from "./schools";
import { schoolClassSectionsSchema } from "./school-class-sections";

/**
 * EXAM STATUS VALUES
 *
 * SCHEDULED  → Exam is planned but not yet started. Default state on creation.
 *              Students can see it in upcoming exams but no results exist yet.
 *
 * ACTIVE     → Exam is currently in progress (dates are today or near).
 *              Can be set manually by staff with exams.status.manage permission.
 *
 * COMPLETED  → All subjects have been conducted and marks entry is expected.
 *              Triggers UI changes (shows "Results" badge in exam list).
 *
 * School owner / assigned staff set this manually via the exam list actions.
 */
export const ExamStatus = {
  SCHEDULED: "SCHEDULED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
} as const;

export type ExamStatusValue = (typeof ExamStatus)[keyof typeof ExamStatus];

export const schoolExamsSchema = sqliteTable("exams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  academicYearId: integer("academic_year_id")
    .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
    .notNull(),
  // === NOW PER CLASS-SECTION (your requirement) ===
  classSectionId: integer("class_section_id")
    .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
    .notNull(),

  name: text("name").notNull(), // "Mid-Term Exam 2026"
  type: text("type").notNull(), // Free-text: "MID_TERM" | "FINAL" | "QUIZ" | anything custom
  description: text("description"),

  // ── EXAM LIFECYCLE STATUS ──────────────────────────────────────────────────
  /**
   * Manually managed by school owner / staff with exams.status.manage permission.
   * Controls visibility cues in the exam list and student/parent portal.
   * Defaults to SCHEDULED on creation.
   */
  status: text("status")
    .$type<ExamStatusValue>()
    .notNull()
    .default("SCHEDULED"),

  // ── CARD PUBLICATION FLAGS ─────────────────────────────────────────────────
  /**
   * When FALSE (default): Students and parents see a "Not published yet" message
   * instead of the actual admit card.
   *
   * When TRUE: The admit card is visible and downloadable by students/parents.
   * Set by school owner / staff with exams.admit-card.publish permission.
   */
  admitCardPublished: integer("admit_card_published", { mode: "boolean" })
    .notNull()
    .default(false),

  /**
   * When FALSE (default): Students and parents see a "Not published yet" message
   * instead of the actual report card.
   *
   * When TRUE: The report card is visible and downloadable by students/parents.
   * Set by school owner / staff with exams.report-card.publish permission.
   */
  reportCardPublished: integer("report_card_published", { mode: "boolean" })
    .notNull()
    .default(false),

  // ── PUBLICATION AUDIT TIMESTAMPS ──────────────────────────────────────────
  admitCardPublishedAt: text("admit_card_published_at"), // ISO timestamp, NULL if not yet published
  reportCardPublishedAt: text("report_card_published_at"), // ISO timestamp, NULL if not yet published

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolExam = typeof schoolExamsSchema.$inferSelect;
export type NewSchoolExam = typeof schoolExamsSchema.$inferInsert;
