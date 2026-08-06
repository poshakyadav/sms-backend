// src/db/schemas/school/school-attendances.ts

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE STATUS ENUM
//
// Each status maps to one of three effective categories used in reporting:
//
//   PRESENT-EQUIVALENT  → counts toward attendance percentage
//     PRESENT   — Student attended the full session.
//     LATE      — Student arrived after roll call but attended. Counts as present
//                 for percentage, flagged separately for punctuality reports.
//     HALF_DAY  — Student attended half the session (morning or afternoon).
//                 Contributes 0.5 to the present count.
//
//   ABSENT-EQUIVALENT  → reduces attendance percentage
//     ABSENT     — Unexcused absence. No prior approval, no medical certificate.
//     SICK       — Student is unwell. Requires medical certificate for multi-day
//                  absences. Counted as absent in percentage but tracked
//                  separately for health/medical reporting dashboards.
//     SUSPENDED  — Student is barred from attending due to a disciplinary action.
//                  Automatically marked absent for those days. Creates an audit
//                  trail that feeds into the discipline report.
//
//   SPECIAL / NEUTRAL  → excluded from the percentage denominator entirely
//                        (neither adds to present count nor penalises the student)
//     EXCUSED    — Pre-approved absence (family emergency, religious observance,
//                  sports tournament, official exam). Requires prior written
//                  approval. Does NOT count against the student's percentage.
//     HOLIDAY    — School-declared holiday, strike, or closure. No one is
//                  expected. Excluded from working-day count.
//     ON_DUTY    — Student is absent from class for an officially sanctioned
//                  school activity (inter-school competition, NCC camp, field
//                  trip). Treated as present for regulatory compliance in most
//                  state boards; excluded from denominator here to keep the
//                  calculation conservative and configurable per school policy.
//
// FORMULA (used in getAttendanceReport / getAttendanceSummaryForStudent):
//   effectivePresent = PRESENT + LATE + (HALF_DAY × 0.5)
//   workingDays = total records − HOLIDAY − EXCUSED − ON_DUTY
//   percentage  = (effectivePresent / workingDays) × 100
// ─────────────────────────────────────────────────────────────────────────────

export const AttendanceStatus = {
  // ── Present-equivalent ────────────────────────────────────────────────────
  PRESENT: "PRESENT", // Full session attended
  LATE: "LATE", // Tardy but attended — counts as present
  HALF_DAY: "HALF_DAY", // Half-session attended — 0.5 credit

  // ── Absent-equivalent ─────────────────────────────────────────────────────
  ABSENT: "ABSENT", // Unexcused, no-show
  SICK: "SICK", // Medical leave (tracked separately from ABSENT)
  SUSPENDED: "SUSPENDED", // Disciplinary bar — auto absent, audit trail kept

  // ── Special / neutral ─────────────────────────────────────────────────────
  EXCUSED: "EXCUSED", // Pre-approved absence — excluded from denominator
  HOLIDAY: "HOLIDAY", // School-declared closure — excluded from denominator
  ON_DUTY: "ON_DUTY", // Official school activity — excluded from denominator
} as const;

export type AttendanceStatusValue =
  (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTIVE CATEGORY HELPERS
// Used by service functions to classify statuses for calculation.
// ─────────────────────────────────────────────────────────────────────────────

/** Statuses that contribute to the present count (HALF_DAY contributes 0.5) */
export const PRESENT_EQUIVALENT_STATUSES: readonly AttendanceStatusValue[] = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.HALF_DAY,
] as const;

/** Statuses that count as absent in the percentage denominator */
export const ABSENT_EQUIVALENT_STATUSES: readonly AttendanceStatusValue[] = [
  AttendanceStatus.ABSENT,
  AttendanceStatus.SICK,
  AttendanceStatus.SUSPENDED,
] as const;

/**
 * Statuses excluded from the working-day denominator entirely.
 * Neither a positive nor a negative — the day simply doesn't count.
 */
export const NEUTRAL_STATUSES: readonly AttendanceStatusValue[] = [
  AttendanceStatus.EXCUSED,
  AttendanceStatus.HOLIDAY,
  AttendanceStatus.ON_DUTY,
] as const;

/** All valid status values as a plain array — used by Zod's z.enum() */
export const ALL_ATTENDANCE_STATUSES = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.HALF_DAY,
  AttendanceStatus.ABSENT,
  AttendanceStatus.SICK,
  AttendanceStatus.SUSPENDED,
  AttendanceStatus.EXCUSED,
  AttendanceStatus.HOLIDAY,
  AttendanceStatus.ON_DUTY,
] as const;

export type AllAttendanceStatusesTuple = typeof ALL_ATTENDANCE_STATUSES;

// ─────────────────────────────────────────────────────────────────────────────
// HALF-DAY VARIANT
// Teachers specify which half the student attended when marking HALF_DAY.
// Stored as a separate nullable field — keeps the main status clean.
// ─────────────────────────────────────────────────────────────────────────────

export const HalfDaySession = {
  MORNING: "MORNING",
  AFTERNOON: "AFTERNOON",
} as const;

export type HalfDaySessionValue =
  (typeof HalfDaySession)[keyof typeof HalfDaySession];

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

export const schoolAttendancesSchema = sqliteTable("attendances", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  enrollmentId: integer("enrollment_id")
    .references(() => schoolStudentEnrollmentsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(),

  // ISO date string "YYYY-MM-DD"
  date: text("date").notNull(),

  // One of the EIGHT non-present AttendanceStatus values.
  // No default — every insert must supply an explicit exception status.
  status: text("status")
    .$type<AttendanceStatusValue>()
    .notNull(),

  // ── HALF-DAY DETAIL ───────────────────────────────────────────────────────
  // Populated only when status = HALF_DAY.
  // Tells the teacher/parent which session the student attended.
  halfDaySession: text("half_day_session").$type<HalfDaySessionValue>(),

  // ── REASON / DOCUMENTATION ────────────────────────────────────────────────
  // Free-text reason or reference. Especially important for:
  //   SICK       → "Medical certificate submitted" / doctor's name
  //   SUSPENDED  → Suspension order reference number
  //   EXCUSED    → Approval note or event name
  //   ON_DUTY    → Activity name (e.g. "District Science Olympiad 2026")
  notes: text("notes"),

  markedBy: integer("marked_by")
    .references(() => schoolUsersSchema.id)
    .notNull(),

  // who last edited this row (distinct from who created it).
  // NULL until the first edit after initial creation.
  updatedBy: integer("updated_by").references(() => schoolUsersSchema.id),

  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
},
  (table) => ({
    // Fast lookup for "does this student have an exception on this date"
    enrollmentDateIdx: index("idx_attendance_enrollment_date").on(
      table.enrollmentId,
      table.date
    ),
  })
);

export type SchoolAttendance = typeof schoolAttendancesSchema.$inferSelect;
export type NewSchoolAttendance = typeof schoolAttendancesSchema.$inferInsert;
