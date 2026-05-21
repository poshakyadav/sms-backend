// src/modules/school/attendance/services.ts

import { getSchoolDB } from "../../../db/school-client";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  schoolAcademicYearsSchema,
  schoolAttendancesSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import {
  AttendanceStatus,
  AttendanceStatusValue,
  NEUTRAL_STATUSES,
} from "../../../db/schemas/school/school-attendances";

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE PERCENTAGE HELPER
//
// Formula:
//   effectivePresent = PRESENT + LATE + (HALF_DAY × 0.5)
//   workingDays      = total records - HOLIDAY - EXCUSED - ON_DUTY
//   percentage       = (effectivePresent / workingDays) × 100
//
// SICK and SUSPENDED count as absent — they reduce the percentage like ABSENT
// does but are tracked as separate buckets for medical and discipline reports.
//
// HOLIDAY, EXCUSED, ON_DUTY are excluded from the denominator so the student
// is not penalised for school-approved or school-declared non-attendance.
// ─────────────────────────────────────────────────────────────────────────────

interface StatusCounts {
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  sick: number;
  suspended: number;
  excused: number;
  holiday: number;
  onDuty: number;
}

/**
 * Derives the final attendance percentage and working-day count from raw
 * per-status counts. Centralised here so every summary endpoint uses the
 * exact same formula.
 */
function deriveAttendanceStats(counts: StatusCounts) {
  const effectivePresent = counts.present + counts.late + counts.halfDay * 0.5;

  // Days the student was genuinely expected to be present
  const workingDays =
    counts.present +
    counts.late +
    counts.halfDay +
    counts.absent +
    counts.sick +
    counts.suspended;
  // EXCUSED, HOLIDAY, ON_DUTY deliberately excluded from denominator

  const totalMarkedDays =
    workingDays + counts.excused + counts.holiday + counts.onDuty;

  const attendancePercentage =
    workingDays > 0
      ? Math.round((effectivePresent / workingDays) * 100 * 10) / 10 // one decimal
      : 0;

  return {
    effectivePresent,
    workingDays,
    totalMarkedDays,
    attendancePercentage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK ATTENDANCE (Batch with Upsert)
//
// Purpose : Teacher marks attendance for an entire class-section on one date.
//           Uses upsert pattern so teachers can correct mistakes later.
//
// Supports all nine AttendanceStatus values including halfDaySession detail.
// ─────────────────────────────────────────────────────────────────────────────

export async function markAttendance(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    date: string;
    classSectionId: number;
    attendances: Array<{
      studentId: number;
      status: AttendanceStatusValue;
      halfDaySession?: "MORNING" | "AFTERNOON";
      notes?: string;
    }>;
  },
  markedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    let marked = 0;
    let updated = 0;

    for (const att of data.attendances) {
      // Resolve enrollment using classSectionId
      const enrollment = await tx
        .select({ id: schoolStudentEnrollmentsSchema.id })
        .from(schoolStudentEnrollmentsSchema)
        .where(
          and(
            eq(schoolStudentEnrollmentsSchema.studentId, att.studentId),
            eq(
              schoolStudentEnrollmentsSchema.classSectionId,
              data.classSectionId
            ),
            eq(schoolStudentEnrollmentsSchema.isActive, true)
          )
        )
        .get();

      if (!enrollment) {
        throw new Error(
          `No active enrollment found for student ${att.studentId} in this class-section`
        );
      }

      const existing = await tx
        .select()
        .from(schoolAttendancesSchema)
        .where(
          and(
            eq(schoolAttendancesSchema.enrollmentId, enrollment.id),
            eq(schoolAttendancesSchema.date, data.date)
          )
        )
        .get();

      const values = {
        enrollmentId: enrollment.id,
        date: data.date,
        status: att.status,
        halfDaySession: att.halfDaySession ?? null,
        notes: att.notes ?? null,
        markedBy,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      };

      if (existing) {
        await tx
          .update(schoolAttendancesSchema)
          .set(values)
          .where(eq(schoolAttendancesSchema.id, existing.id));
        updated++;
      } else {
        await tx.insert(schoolAttendancesSchema).values(values);
        marked++;
      }
    }

    return {
      message: `Marked ${marked} new and updated ${updated} existing records`,
      new: marked,
      updated,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE BY STUDENT (Staff view — any student, date range)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceByStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolAttendancesSchema.id,
      date: schoolAttendancesSchema.date,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      markedBy: schoolAttendancesSchema.markedBy,
      createdAt: schoolAttendancesSchema.createdAt,
      updatedAt: schoolAttendancesSchema.updatedAt,
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        gte(schoolAttendancesSchema.date, fromDate),
        lte(schoolAttendancesSchema.date, toDate)
      )
    )
    .orderBy(schoolAttendancesSchema.date);
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES FOR getAttendanceByClassSection RESPONSE
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * Per-student row returned by getAttendanceByClassSection.
 *
 * attendanceRecord is null when no attendance has been marked for
 * this student on this date — this is the "unmarked" sentinel.
 */
export interface ClassAttendanceStudentRow {
  // Enrollment identity
  enrollmentId: number;
  studentId: number;
  studentName: string;
  rollNumber: string | null;
  avatarUrl: string | null;
 
  // Today's attendance record (null = not yet marked for this student)
  attendanceRecord: {
    id: number;
    status: AttendanceStatusValue;
    halfDaySession: "MORNING" | "AFTERNOON" | null;
    notes: string | null;
    markedBy: number;
    markedByName: string;
    updatedAt: string;
  } | null;
}
 
/**
 * Session-level metadata returned alongside the student rows.
 *
 * isMarked = true only when EVERY active enrolled student has a record for
 * this date. Partial marking is surfaced separately via markedCount / totalCount.
 *
 * This is the single field the frontend checks to render "✓ Attendance marked"
 * or "⚠ Attendance not marked yet" on the teacher's class sheet header.
 */
export interface ClassAttendanceSessionMeta {
  /** Date this metadata describes ("YYYY-MM-DD") */
  date: string;
  /** classSectionId this metadata describes */
  classSectionId: number;
 
  /**
   * True only when every enrolled student has an attendance record for this date.
   * Partial marking → false; teacher should re-open the sheet to complete it.
   */
  isFullyMarked: boolean;
 
  /**
   * True when at least one student has a record for this date (partial or full).
   * Lets the frontend distinguish "never opened" vs "started but not finished".
   */
  isPartiallyMarked: boolean;
 
  /** How many students have a record for this date */
  markedCount: number;
 
  /** Total active enrolled students in this class-section */
  totalCount: number;
 
  /**
   * The teacher who last created or updated any attendance record for this date.
   * Null when isPartiallyMarked is false (no records exist at all).
   */
  lastMarkedBy: {
    userId: number;
    name: string;
  } | null;
 
  /**
   * ISO timestamp of the most recent INSERT or UPDATE among all records for
   * this date in this class-section. Null when no records exist.
   * Displayed as "Last updated at HH:mm" on the sheet header.
   */
  lastUpdatedAt: string | null;
}
 
/**
 * Full response shape from getAttendanceByClassSection.
 */
export interface ClassAttendanceResponse {
  session: ClassAttendanceSessionMeta;
  students: ClassAttendanceStudentRow[];
}
 
// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE BY CLASS-SECTION & DATE (Teacher class-sheet view)
//
// PRODUCTION-GRADE REWRITE:
//
//   Previously this function only returned rows that ALREADY HAD attendance
//   records (inner join). The frontend had to make a second API call to get
//   enrolled students and merge them manually.
//
//   Now this function:
//     1. Fetches ALL active enrollments for the class-section.
//     2. LEFT JOINs attendance records for the requested date.
//     3. JOINs the marking teacher's name onto each attendance row.
//     4. Computes session-level metadata (isFullyMarked, markedCount,
//        lastMarkedBy, lastUpdatedAt) in the same DB round-trip.
//     5. Returns a single response — no second API call needed.
//
//   This approach ensures:
//     • Students with no record for the date appear as attendanceRecord: null
//       (the frontend defaults them to PRESENT before the teacher submits).
//     • The session banner shows correct marking status immediately on page load.
//     • One DB connection round-trip total (two queries: enrollments + metadata).
// ─────────────────────────────────────────────────────────────────────────────
 
export async function getAttendanceByClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number,
  date: string
): Promise<ClassAttendanceResponse> {
  const db = await getSchoolDB(env, schoolCode);
 
  // ── Query 1: All active enrollments + LEFT JOIN their attendance for this date ──
  // We alias schoolUsersSchema twice — once for the student, once for the teacher
  // who marked the record. Drizzle doesn't support self-join aliases natively,
  // so we use a raw sql sub-select for the teacher name to keep the query clean.
 
  const rows = await db
    .select({
      // Enrollment fields
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      avatarUrl: schoolUsersSchema.avatarUrl,
 
      // Attendance fields (null when no record for this date)
      attendanceId: schoolAttendancesSchema.id,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      markedBy: schoolAttendancesSchema.markedBy,
      updatedAt: schoolAttendancesSchema.updatedAt,
 
      // Teacher name resolved via correlated sub-query
      // (avoids a second self-join on schoolUsersSchema)
      markedByName: sql<string>`(
        SELECT su.name
        FROM school_users su
        WHERE su.id = ${schoolAttendancesSchema.markedBy}
      )`.as("marked_by_name"),
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .leftJoin(
      schoolAttendancesSchema,
      and(
        eq(
          schoolAttendancesSchema.enrollmentId,
          schoolStudentEnrollmentsSchema.id
        ),
        eq(schoolAttendancesSchema.date, date)
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .orderBy(
      // Numeric roll number sort (students without roll number sort last)
      sql`CASE WHEN ${schoolStudentEnrollmentsSchema.rollNumber} IS NULL THEN 1 ELSE 0 END`,
      sql`CAST(${schoolStudentEnrollmentsSchema.rollNumber} AS INTEGER)`,
      schoolUsersSchema.name
    );
 
  // ── Build student rows ────────────────────────────────────────────────────
 
  const students: ClassAttendanceStudentRow[] = rows.map((row) => ({
    enrollmentId: row.enrollmentId,
    studentId: row.studentId,
    studentName: row.studentName,
    rollNumber: row.rollNumber ?? null,
    avatarUrl: row.avatarUrl ?? null,
 
    attendanceRecord:
      row.attendanceId != null
        ? {
            id: row.attendanceId,
            status: row.status as AttendanceStatusValue,
            halfDaySession: (row.halfDaySession as "MORNING" | "AFTERNOON") ?? null,
            notes: row.notes ?? null,
            markedBy: row.markedBy!,
            markedByName: row.markedByName ?? "Unknown",
            updatedAt: row.updatedAt!,
          }
        : null,
  }));
 
  // ── Compute session metadata from the already-fetched rows ───────────────
  // No extra DB query needed — we derive everything from `rows` in JS.
 
  const totalCount = rows.length;
  const markedRows = rows.filter((r) => r.attendanceId != null);
  const markedCount = markedRows.length;
 
  const isFullyMarked = totalCount > 0 && markedCount === totalCount;
  const isPartiallyMarked = markedCount > 0 && markedCount < totalCount;
 
  // Find the most recently updated record across all marked rows
  let lastUpdatedAt: string | null = null;
  let lastMarkedByUserId: number | null = null;
  let lastMarkedByName: string | null = null;
 
  for (const r of markedRows) {
    // updatedAt is an ISO string; lexicographic comparison is safe for ISO dates
    if (r.updatedAt != null) {
      if (lastUpdatedAt === null || r.updatedAt > lastUpdatedAt) {
        lastUpdatedAt = r.updatedAt;
        lastMarkedByUserId = r.markedBy ?? null;
        lastMarkedByName = r.markedByName ?? null;
      }
    }
  }
 
  const session: ClassAttendanceSessionMeta = {
    date,
    classSectionId,
    isFullyMarked,
    isPartiallyMarked,
    markedCount,
    totalCount,
    lastMarkedBy:
      lastMarkedByUserId != null
        ? { userId: lastMarkedByUserId, name: lastMarkedByName ?? "Unknown" }
        : null,
    lastUpdatedAt,
  };
 
  return { session, students };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE REPORT (Monthly Summary — Staff view)
//
// Returns a row per student with all nine status counts + the derived
// attendance percentage using the production-grade formula.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { classSectionId?: number; month?: number; year?: number }
) {
  const db = await getSchoolDB(env, schoolCode);

  const year = data.year ?? new Date().getFullYear();
  const month = data.month;
  if (!month) throw new Error("Month is required for attendance report");

  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  // Scope to active academic year so past-year enrollments don't bleed in
  const currentYear = await db
    .select({ id: schoolAcademicYearsSchema.id })
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No active academic year found");

  const enrollmentWhere = [
    eq(schoolStudentEnrollmentsSchema.isActive, true),
    eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
  ];

  if (data.classSectionId) {
    enrollmentWhere.push(
      eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
    );
  }

  const reportData = await db
    .select({
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,

      // ── All nine status buckets ────────────────────────────────────────────
      present: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.PRESENT} THEN 1 END)
      `.as("present"),

      late: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.LATE} THEN 1 END)
      `.as("late"),

      halfDay: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HALF_DAY} THEN 1 END)
      `.as("half_day"),

      absent: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ABSENT} THEN 1 END)
      `.as("absent"),

      sick: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SICK} THEN 1 END)
      `.as("sick"),

      suspended: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SUSPENDED} THEN 1 END)
      `.as("suspended"),

      excused: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.EXCUSED} THEN 1 END)
      `.as("excused"),

      holiday: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HOLIDAY} THEN 1 END)
      `.as("holiday"),

      onDuty: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ON_DUTY} THEN 1 END)
      `.as("on_duty"),
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .leftJoin(
      schoolAttendancesSchema,
      and(
        eq(
          schoolStudentEnrollmentsSchema.id,
          schoolAttendancesSchema.enrollmentId
        ),
        sql`${schoolAttendancesSchema.date} LIKE ${datePattern}`
      )
    )
    .where(and(...enrollmentWhere))
    .groupBy(
      schoolStudentEnrollmentsSchema.studentId,
      schoolUsersSchema.name,
      schoolStudentEnrollmentsSchema.rollNumber
    )
    .orderBy(
      data.classSectionId
        ? sql`CAST(${schoolStudentEnrollmentsSchema.rollNumber} AS INTEGER)`
        : schoolUsersSchema.name
    );

  return reportData.map((row: any) => {
    const counts: StatusCounts = {
      present: row.present || 0,
      late: row.late || 0,
      halfDay: row.halfDay || 0,
      absent: row.absent || 0,
      sick: row.sick || 0,
      suspended: row.suspended || 0,
      excused: row.excused || 0,
      holiday: row.holiday || 0,
      onDuty: row.onDuty || 0,
    };

    const {
      effectivePresent,
      workingDays,
      totalMarkedDays,
      attendancePercentage,
    } = deriveAttendanceStats(counts);

    return {
      studentId: row.studentId,
      studentName: row.studentName,
      rollNumber: row.rollNumber ?? null,
      totalDaysInMonth,
      totalMarkedDays,
      workingDays, // days student was expected to attend
      // ── All nine buckets ──
      ...counts,
      // ── Derived ───────────────────────────────────────────────────────────
      effectivePresent, // PRESENT + LATE + HALF_DAY×0.5
      attendancePercentage,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE BY STUDENT SELF (Student portal — own records, date range)
//
// Security: userId from JWT — cannot be spoofed by the client.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceByStudentSelf(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolAttendancesSchema.id,
      date: schoolAttendancesSchema.date,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      createdAt: schoolAttendancesSchema.createdAt,
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, userId),
        gte(schoolAttendancesSchema.date, fromDate),
        lte(schoolAttendancesSchema.date, toDate)
      )
    )
    .orderBy(schoolAttendancesSchema.date);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE SUMMARY FOR STUDENT SELF (Student portal — monthly card)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceSummaryForStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  month: number,
  year: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  const row = await db
    .select({
      present: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.PRESENT} THEN 1 END)
      `.as("present"),
      late: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.LATE} THEN 1 END)
      `.as("late"),
      halfDay: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HALF_DAY} THEN 1 END)
      `.as("half_day"),
      absent: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ABSENT} THEN 1 END)
      `.as("absent"),
      sick: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SICK} THEN 1 END)
      `.as("sick"),
      suspended: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SUSPENDED} THEN 1 END)
      `.as("suspended"),
      excused: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.EXCUSED} THEN 1 END)
      `.as("excused"),
      holiday: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HOLIDAY} THEN 1 END)
      `.as("holiday"),
      onDuty: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ON_DUTY} THEN 1 END)
      `.as("on_duty"),
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, userId),
        sql`${schoolAttendancesSchema.date} LIKE ${datePattern}`
      )
    )
    .get();

  const counts: StatusCounts = {
    present: row?.present ?? 0,
    late: row?.late ?? 0,
    halfDay: row?.halfDay ?? 0,
    absent: row?.absent ?? 0,
    sick: row?.sick ?? 0,
    suspended: row?.suspended ?? 0,
    excused: row?.excused ?? 0,
    holiday: row?.holiday ?? 0,
    onDuty: row?.onDuty ?? 0,
  };

  const {
    effectivePresent,
    workingDays,
    totalMarkedDays,
    attendancePercentage,
  } = deriveAttendanceStats(counts);

  return {
    month,
    year,
    totalDaysInMonth,
    totalMarkedDays,
    workingDays,
    ...counts,
    effectivePresent,
    attendancePercentage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE FOR PARENT CHILD VIEW (date range)
//
// Security:
//   - parentUserId  from JWT (cannot be spoofed)
//   - childStudentId from X-Active-Child-Id header
//   - Parent–child link verified in student_parents table before any data is returned.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceForParentChildView(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number,
  childStudentId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Security check: verify parent–child relationship ──────────────────────
  const link = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.parentId, parentUserId),
        eq(studentParentsSchema.studentId, childStudentId)
      )
    )
    .get();

  if (!link) {
    throw new Error("Unauthorized: no parent-child relationship found");
  }

  return await db
    .select({
      id: schoolAttendancesSchema.id,
      date: schoolAttendancesSchema.date,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      createdAt: schoolAttendancesSchema.createdAt,
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, childStudentId),
        gte(schoolAttendancesSchema.date, fromDate),
        lte(schoolAttendancesSchema.date, toDate)
      )
    )
    .orderBy(schoolAttendancesSchema.date);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE SUMMARY FOR PARENT CHILD VIEW (monthly)
//
// Same security check as getAttendanceForParentChildView.
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceSummaryForParentChild(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number,
  childStudentId: number,
  month: number,
  year: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Security check ────────────────────────────────────────────────────────
  const link = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.parentId, parentUserId),
        eq(studentParentsSchema.studentId, childStudentId)
      )
    )
    .get();

  if (!link) {
    throw new Error("Unauthorized: no parent-child relationship found");
  }

  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  const row = await db
    .select({
      present: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.PRESENT} THEN 1 END)
      `.as("present"),
      late: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.LATE} THEN 1 END)
      `.as("late"),
      halfDay: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HALF_DAY} THEN 1 END)
      `.as("half_day"),
      absent: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ABSENT} THEN 1 END)
      `.as("absent"),
      sick: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SICK} THEN 1 END)
      `.as("sick"),
      suspended: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SUSPENDED} THEN 1 END)
      `.as("suspended"),
      excused: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.EXCUSED} THEN 1 END)
      `.as("excused"),
      holiday: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HOLIDAY} THEN 1 END)
      `.as("holiday"),
      onDuty: sql<number>`
        COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ON_DUTY} THEN 1 END)
      `.as("on_duty"),
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, childStudentId),
        sql`${schoolAttendancesSchema.date} LIKE ${datePattern}`
      )
    )
    .get();

  const counts: StatusCounts = {
    present: row?.present ?? 0,
    late: row?.late ?? 0,
    halfDay: row?.halfDay ?? 0,
    absent: row?.absent ?? 0,
    sick: row?.sick ?? 0,
    suspended: row?.suspended ?? 0,
    excused: row?.excused ?? 0,
    holiday: row?.holiday ?? 0,
    onDuty: row?.onDuty ?? 0,
  };

  const {
    effectivePresent,
    workingDays,
    totalMarkedDays,
    attendancePercentage,
  } = deriveAttendanceStats(counts);

  return {
    month,
    year,
    totalDaysInMonth,
    totalMarkedDays,
    workingDays,
    ...counts,
    effectivePresent,
    attendancePercentage,
  };
}
