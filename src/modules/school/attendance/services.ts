// src/modules/school/attendance/services.ts

import { getSchoolDB } from "../../../db/school-client";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  schoolAcademicYearsSchema,
  schoolAttendancesSchema,
  schoolAttendanceSessionsSchema,
  schoolAttendanceAuditLogSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import {
  AttendanceStatus,
  AttendanceStatusValue,
} from "../../../db/schemas/school/school-attendances";
import {
  CalendarDayType,
  CalendarDayTypeValue,
} from "../../../db/schemas/school/school-attendance-calendar";
import {
  countWorkingDaysInRange,
  resolveDayTypeDetailed,
  resolveDayTypesForRange,
} from "./calendar-service";

// ─────────────────────────────────────────────────────────────────────────────
// STATUS COUNTS + PERCENTAGE DERIVATION (unchanged — this part was already fixed)
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

function emptyCounts(): StatusCounts {
  return {
    present: 0, late: 0, halfDay: 0, absent: 0,
    sick: 0, suspended: 0, excused: 0, holiday: 0, onDuty: 0,
  };
}

function deriveAttendanceStats(counts: StatusCounts, markedDays: number) {
  const effectivePresent = counts.present + counts.late + counts.halfDay * 0.5;
  const denominator = markedDays - counts.excused - counts.onDuty;
  const attendancePercentage =
    denominator > 0 ? Math.round((effectivePresent / denominator) * 100 * 10) / 10 : 0;
  return { effectivePresent, denominator, attendancePercentage };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK ATTENDANCE (Batch, exception-only writes + session upsert + audit log)
//
// NEW: calendar guard.
//   1. Per-student HOLIDAY status is retired — the attendance_calendar table
//      is now the single source of truth for holidays. Accepting HOLIDAY here
//      would create data that every summary/report function silently ignores
//      (see getStudentMonthlyCounts, which always reports holiday: 0) — better
//      to reject it loudly than let it rot invisibly.
//   2. Block marking on any date the calendar says is a holiday for this
//      class-section. This is the actual fix for "teacher takes attendance
//      during summer break" — it can't happen anymore, not just "shouldn't."
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
  const holidayAttempt = data.attendances.find(
    (a) => a.status === AttendanceStatus.HOLIDAY
  );
  if (holidayAttempt) {
    throw new Error(
      "Marking individual students as HOLIDAY is no longer supported. Declare the holiday on the attendance calendar instead — POST /school/attendance/calendar/holiday — it covers the whole class-section (or the whole school) in one call."
    );
  }

  const resolution = await resolveDayTypeDetailed(env, schoolCode, data.classSectionId, data.date);
  const isResolved = resolution.isExplicit || resolution.source === "WEEKLY_OFF";

  if (!isResolved) {
    throw new Error(
      `The attendance calendar for ${data.date} hasn't been marked yet for this class-section. An authorized staff member must first declare this date as a Working Day or Holiday before attendance can be recorded.`
    );
  }
  if (resolution.dayType === "HOLIDAY") {
    const scopeLabel =
      resolution.source === "SCHOOL_WIDE" ? "school-wide" :
        resolution.source === "WEEKLY_OFF" ? "the weekly off" : "this class-section";
    throw new Error(
      `${data.date} is declared a holiday (${scopeLabel}${resolution.reason ? " — " + resolution.reason : ""}). Override the calendar to Working Day first if attendance genuinely needs to be recorded.`
    );
  }

  const db = await getSchoolDB(env, schoolCode);
  const studentIds = data.attendances.map((a) => a.studentId);

  // ── STEP 1: fetch everything we need, in PARALLEL, up front. ─────────────
  // This is 4 concurrent network calls instead of the ~120 sequential ones
  // the old per-student loop made. No writes happen yet, so this is safe to
  // parallelize freely.
  const [enrollments, existingRows, rosterCountRow, existingSession] = await Promise.all([
    db
      .select({
        id: schoolStudentEnrollmentsSchema.id,
        studentId: schoolStudentEnrollmentsSchema.studentId,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId),
          eq(schoolStudentEnrollmentsSchema.isActive, true),
          inArray(schoolStudentEnrollmentsSchema.studentId, studentIds)
        )
      ),
    // ALL existing attendance rows for this class-section + date, in ONE query
    // (used to be one SELECT per student).
    db
      .select({
        id: schoolAttendancesSchema.id,
        enrollmentId: schoolAttendancesSchema.enrollmentId,
        status: schoolAttendancesSchema.status,
      })
      .from(schoolAttendancesSchema)
      .innerJoin(
        schoolStudentEnrollmentsSchema,
        eq(schoolAttendancesSchema.enrollmentId, schoolStudentEnrollmentsSchema.id)
      )
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId),
          eq(schoolAttendancesSchema.date, data.date)
        )
      ),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get(),
    db
      .select()
      .from(schoolAttendanceSessionsSchema)
      .where(
        and(
          eq(schoolAttendanceSessionsSchema.classSectionId, data.classSectionId),
          eq(schoolAttendanceSessionsSchema.date, data.date)
        )
      )
      .get(),
  ]);

  const enrollmentByStudent = new Map(enrollments.map((e) => [e.studentId, e.id]));
  const existingByEnrollment = new Map(existingRows.map((r) => [r.enrollmentId, r]));

  // ── STEP 2: pure in-memory computation. Zero DB calls in this loop. ──────
  let inserted = 0, updated = 0, cleared = 0, unchanged = 0;

  const toInsert: (typeof schoolAttendancesSchema.$inferInsert)[] = [];
  const deleteIds: number[] = [];
  const pendingUpdates: {
    id: number;
    status: AttendanceStatusValue;
    halfDaySession: "MORNING" | "AFTERNOON" | null;
    notes: string | null;
  }[] = [];
  const auditRows: (typeof schoolAttendanceAuditLogSchema.$inferInsert)[] = [];

  for (const att of data.attendances) {
    const enrollmentId = enrollmentByStudent.get(att.studentId);
    if (!enrollmentId) {
      throw new Error(
        `No active enrollment found for student ${att.studentId} in this class-section`
      );
    }

    const existing = existingByEnrollment.get(enrollmentId);
    const oldStatus: AttendanceStatusValue | null = existing?.status ?? null;
    const newStatus: AttendanceStatusValue | null =
      att.status === AttendanceStatus.PRESENT ? null : att.status;

    if (oldStatus === newStatus) {
      unchanged++;
      continue;
    }

    if (newStatus === null) {
      deleteIds.push(existing!.id);
      cleared++;
    } else if (existing) {
      pendingUpdates.push({
        id: existing.id,
        status: newStatus,
        halfDaySession: att.halfDaySession ?? null,
        notes: att.notes ?? null,
      });
      updated++;
    } else {
      toInsert.push({
        enrollmentId,
        date: data.date,
        status: newStatus,
        halfDaySession: att.halfDaySession ?? null,
        notes: att.notes ?? null,
        markedBy,
      });
      inserted++;
    }

    auditRows.push({
      enrollmentId,
      date: data.date,
      oldStatus,
      newStatus,
      changedBy: markedBy,
    });
  }

  const totalStudents = rosterCountRow?.count ?? enrollments.length;
  // Exceptions after this write = (exceptions before) - cleared + inserted.
  // Updates don't change the count; unchanged rows aren't touched.
  const exceptionCount = existingRows.length - cleared + inserted;

  // ── STEP 3: write everything in ONE atomic batch call. ────────────────────
  // db.batch() sends every statement in a single HTTP request to Turso and
  // runs them all inside one implicit transaction (all-or-nothing) — unlike
  // db.transaction(), which for libSQL-over-HTTP requires a strictly
  // sequential round trip per statement via a server-side "baton" that has
  // its own idle/duration timeout. A transaction open for 6+ seconds across
  // 100+ round trips risks that timeout expiring server-side — which can
  // silently drop the writes even though the client-side code never throws
  // (exactly the "201 success, nothing saved" symptom you're seeing).
  // batch() has no such risk: it's one request, done or not done.
  const statements: any[] = [];

  if (toInsert.length > 0) {
    statements.push(db.insert(schoolAttendancesSchema).values(toInsert));
  }
  if (deleteIds.length > 0) {
    statements.push(
      db.delete(schoolAttendancesSchema).where(inArray(schoolAttendancesSchema.id, deleteIds))
    );
  }
  for (const upd of pendingUpdates) {
    statements.push(
      db
        .update(schoolAttendancesSchema)
        .set({
          status: upd.status,
          halfDaySession: upd.halfDaySession,
          notes: upd.notes,
          updatedBy: markedBy,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(schoolAttendancesSchema.id, upd.id))
    );
  }
  if (auditRows.length > 0) {
    statements.push(db.insert(schoolAttendanceAuditLogSchema).values(auditRows));
  }

  if (existingSession) {
    statements.push(
      db
        .update(schoolAttendanceSessionsSchema)
        .set({
          lastEditedBy: markedBy,
          lastEditedAt: sql`CURRENT_TIMESTAMP`,
          totalStudents,
          exceptionCount,
        })
        .where(eq(schoolAttendanceSessionsSchema.id, existingSession.id))
    );
  } else {
    statements.push(
      db.insert(schoolAttendanceSessionsSchema).values({
        classSectionId: data.classSectionId,
        date: data.date,
        markedBy,
        totalStudents,
        exceptionCount,
      })
    );
  }

  if (statements.length > 0) {
    await db.batch(statements as [any, ...any[]]);
  }

  return {
    message: `${inserted} new exception${inserted === 1 ? "" : "s"}, ${updated} updated, ${cleared} cleared to present, ${unchanged} unchanged`,
    inserted,
    updated,
    cleared,
    unchanged,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE BY CLASS-SECTION & DATE (Teacher class-sheet view)
//
// NEW: session meta now carries the calendar's dayType/isHoliday for this
// exact date, so the frontend can show "This date is a declared holiday" and
// disable the mark-attendance UI instead of letting the teacher hit the
// (now-blocking) POST and get a confusing error.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassAttendanceStudentRow {
  enrollmentId: number;
  studentId: number;
  studentName: string;
  rollNumber: string | null;
  avatarUrl: string | null;
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

export interface ClassAttendanceSessionMeta {
  date: string;
  classSectionId: number;
  dayType: CalendarDayTypeValue;
  isHoliday: boolean;
  /** True once attendance has been taken for this date at all. */
  isMarked: boolean;
  totalCount: number;
  exceptionCount: number;
  markedBy: { userId: number; name: string } | null;
  markedAt: string | null;
  lastEditedBy: { userId: number; name: string } | null;
  lastEditedAt: string | null;
}

export interface ClassAttendanceResponse {
  session: ClassAttendanceSessionMeta;
  students: ClassAttendanceStudentRow[];
}

export async function getAttendanceByClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number,
  date: string
): Promise<ClassAttendanceResponse> {
  const db = await getSchoolDB(env, schoolCode);

  const dayTypes = await resolveDayTypesForRange(env, schoolCode, classSectionId, date, date);
  const dayType = dayTypes.get(date) ?? CalendarDayType.WORKING_DAY;

  const session = await db
    .select()
    .from(schoolAttendanceSessionsSchema)
    .where(
      and(
        eq(schoolAttendanceSessionsSchema.classSectionId, classSectionId),
        eq(schoolAttendanceSessionsSchema.date, date)
      )
    )
    .get();

  let markedByName: string | null = null;
  let lastEditedByName: string | null = null;

  if (session) {
    const ids = [session.markedBy, session.lastEditedBy].filter(
      (x): x is number => x != null
    );
    const names = await db
      .select({ id: schoolUsersSchema.id, name: schoolUsersSchema.name })
      .from(schoolUsersSchema)
      .where(inArray(schoolUsersSchema.id, ids));
    const nameMap = new Map(names.map((n) => [n.id, n.name]));
    markedByName = nameMap.get(session.markedBy) ?? null;
    lastEditedByName = session.lastEditedBy
      ? nameMap.get(session.lastEditedBy) ?? null
      : null;
  }

  const rows = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      avatarUrl: schoolUsersSchema.avatarUrl,

      attendanceId: schoolAttendancesSchema.id,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      markedBy: schoolAttendancesSchema.markedBy,
      updatedAt: schoolAttendancesSchema.updatedAt,

      markedByName: sql<string>`(
        SELECT su.name FROM school_users su
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
        eq(schoolAttendancesSchema.enrollmentId, schoolStudentEnrollmentsSchema.id),
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
      sql`CASE WHEN ${schoolStudentEnrollmentsSchema.rollNumber} IS NULL THEN 1 ELSE 0 END`,
      sql`CAST(${schoolStudentEnrollmentsSchema.rollNumber} AS INTEGER)`,
      schoolUsersSchema.name
    );

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

  return {
    session: {
      date,
      classSectionId,
      dayType,
      isHoliday: dayType === CalendarDayType.HOLIDAY,
      isMarked: session != null,
      totalCount: rows.length,
      exceptionCount: rows.filter((r) => r.attendanceId != null).length,
      markedBy: session
        ? { userId: session.markedBy, name: markedByName ?? "Unknown" }
        : null,
      markedAt: session?.markedAt ?? null,
      lastEditedBy: session?.lastEditedBy
        ? { userId: session.lastEditedBy, name: lastEditedByName ?? "Unknown" }
        : null,
      lastEditedAt: session?.lastEditedAt ?? null,
    },
    students,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECORD RECONSTRUCTION HELPER (shared by student/self/parent history views)
//
// REWRITTEN: this is where the actual gap lived. The old version only ever
// produced a record for dates where a `attendance_sessions` row existed —
// so a date with no session (holiday OR forgotten) just silently vanished
// from the output. That's "safe" in that it never showed a missing day as
// present, but it also never told anyone attendance was missing.
//
// Now every date in [fromDate, toDate] is classified using the calendar:
//   HOLIDAY (calendar)                → status "HOLIDAY", isHoliday: true
//   WORKING_DAY + session + exception → the actual exception status
//   WORKING_DAY + session, no excep.  → implicit PRESENT
//   WORKING_DAY + no session at all   → status "UNMARKED" — genuinely missing
// "UNMARKED" is never counted as present anywhere downstream.
// ─────────────────────────────────────────────────────────────────────────────

export type ReconstructedStatus = AttendanceStatusValue | "UNMARKED";

export interface ReconstructedAttendanceRecord {
  id: number | null; // null = no attendances row (present, holiday, or unmarked)
  date: string;
  status: ReconstructedStatus;
  halfDaySession: "MORNING" | "AFTERNOON" | null;
  notes: string | null;
  createdAt: string | null;
  isImplicit: boolean;
  isHoliday: boolean;
}

async function buildAttendanceRecordsForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  db: Awaited<ReturnType<typeof getSchoolDB>>,
  enrollmentId: number,
  classSectionId: number,
  fromDate: string,
  toDate: string
): Promise<ReconstructedAttendanceRecord[]> {
  const dayTypes = await resolveDayTypesForRange(
    env, schoolCode, classSectionId, fromDate, toDate
  );

  const sessions = await db
    .select({ date: schoolAttendanceSessionsSchema.date })
    .from(schoolAttendanceSessionsSchema)
    .where(
      and(
        eq(schoolAttendanceSessionsSchema.classSectionId, classSectionId),
        gte(schoolAttendanceSessionsSchema.date, fromDate),
        lte(schoolAttendanceSessionsSchema.date, toDate)
      )
    );
  const sessionDates = new Set(sessions.map((s) => s.date));

  const exceptions = await db
    .select({
      id: schoolAttendancesSchema.id,
      date: schoolAttendancesSchema.date,
      status: schoolAttendancesSchema.status,
      halfDaySession: schoolAttendancesSchema.halfDaySession,
      notes: schoolAttendancesSchema.notes,
      createdAt: schoolAttendancesSchema.createdAt,
    })
    .from(schoolAttendancesSchema)
    .where(
      and(
        eq(schoolAttendancesSchema.enrollmentId, enrollmentId),
        gte(schoolAttendancesSchema.date, fromDate),
        lte(schoolAttendancesSchema.date, toDate)
      )
    );
  const exceptionByDate = new Map(exceptions.map((e) => [e.date, e]));

  const records: ReconstructedAttendanceRecord[] = [];

  for (const [date, dayType] of dayTypes) {
    if (dayType === CalendarDayType.HOLIDAY) {
      records.push({
        id: null,
        date,
        status: "HOLIDAY",
        halfDaySession: null,
        notes: null,
        createdAt: null,
        isImplicit: true,
        isHoliday: true,
      });
      continue;
    }

    const ex = exceptionByDate.get(date);
    if (ex) {
      records.push({
        id: ex.id,
        date: ex.date,
        status: ex.status as AttendanceStatusValue,
        halfDaySession: (ex.halfDaySession as "MORNING" | "AFTERNOON") ?? null,
        notes: ex.notes ?? null,
        createdAt: ex.createdAt,
        isImplicit: false,
        isHoliday: false,
      });
    } else if (sessionDates.has(date)) {
      records.push({
        id: null,
        date,
        status: AttendanceStatus.PRESENT,
        halfDaySession: null,
        notes: null,
        createdAt: null,
        isImplicit: true,
        isHoliday: false,
      });
    } else {
      // Working day, per the calendar — but nobody ever opened this
      // class-section's attendance sheet for this date. This is the
      // "teacher forgot" case, and it must never be reported as present.
      records.push({
        id: null,
        date,
        status: "UNMARKED",
        halfDaySession: null,
        notes: null,
        createdAt: null,
        isImplicit: true,
        isHoliday: false,
      });
    }
  }

  return records.sort((a, b) => a.date.localeCompare(b.date));
}

/** Reconstructs records for a student across ALL their enrollments in range
 *  (handles mid-year class-section transfers). De-dupes by date, preferring
 *  the non-implicit (exception) record if two enrollments somehow overlap. */
async function getStudentAttendanceRecords(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  db: Awaited<ReturnType<typeof getSchoolDB>>,
  studentId: number,
  fromDate: string,
  toDate: string
): Promise<ReconstructedAttendanceRecord[]> {
  const enrollments = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
    })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId));

  const byDate = new Map<string, ReconstructedAttendanceRecord>();

  for (const enr of enrollments) {
    const records = await buildAttendanceRecordsForEnrollment(
      env, schoolCode, db, enr.id, enr.classSectionId, fromDate, toDate
    );
    for (const r of records) {
      const existing = byDate.get(r.date);
      if (!existing || (existing.isImplicit && !r.isImplicit)) {
        byDate.set(r.date, r);
      }
    }
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
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
  return getStudentAttendanceRecords(env, schoolCode, db, studentId, fromDate, toDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE BY STUDENT SELF (Student portal)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceByStudentSelf(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);
  return getStudentAttendanceRecords(env, schoolCode, db, userId, fromDate, toDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE FOR PARENT CHILD VIEW (date range)
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

  if (!link) throw new Error("Unauthorized: no parent-child relationship found");

  return getStudentAttendanceRecords(env, schoolCode, db, childStudentId, fromDate, toDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// MONTHLY STATUS COUNTS (unchanged — this was already fixed on your end)
// ─────────────────────────────────────────────────────────────────────────────

async function getStudentMonthlyCounts(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  db: Awaited<ReturnType<typeof getSchoolDB>>,
  studentId: number,
  fromDate: string,
  toDate: string,
  datePattern: string
): Promise<{ counts: StatusCounts; workingDays: number; markedDays: number; unmarkedDays: number }> {
  const enrollment = await db
    .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) return { counts: emptyCounts(), workingDays: 0, markedDays: 0, unmarkedDays: 0 };

  const workingDays = await countWorkingDaysInRange(
    env, schoolCode, enrollment.classSectionId, fromDate, toDate
  );

  const [exceptionRow, markedDaysRow] = await Promise.all([
    db
      .select({
        late: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.LATE} THEN 1 END)`.as("late"),
        halfDay: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HALF_DAY} THEN 1 END)`.as("half_day"),
        absent: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ABSENT} THEN 1 END)`.as("absent"),
        sick: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SICK} THEN 1 END)`.as("sick"),
        suspended: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SUSPENDED} THEN 1 END)`.as("suspended"),
        excused: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.EXCUSED} THEN 1 END)`.as("excused"),
        onDuty: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ON_DUTY} THEN 1 END)`.as("on_duty"),
      })
      .from(schoolAttendancesSchema)
      .innerJoin(
        schoolStudentEnrollmentsSchema,
        eq(schoolAttendancesSchema.enrollmentId, schoolStudentEnrollmentsSchema.id)
      )
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, studentId),
          sql`${schoolAttendancesSchema.date} LIKE ${datePattern}`
        )
      )
      .get(),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schoolAttendanceSessionsSchema)
      .where(
        and(
          eq(schoolAttendanceSessionsSchema.classSectionId, enrollment.classSectionId),
          sql`${schoolAttendanceSessionsSchema.date} LIKE ${datePattern}`
        )
      )
      .get(),
  ]);

  const markedDays = markedDaysRow?.count ?? 0;
  const unmarkedDays = Math.max(0, workingDays - markedDays);

  const late = exceptionRow?.late ?? 0;
  const halfDay = exceptionRow?.halfDay ?? 0;
  const absent = exceptionRow?.absent ?? 0;
  const sick = exceptionRow?.sick ?? 0;
  const suspended = exceptionRow?.suspended ?? 0;
  const excused = exceptionRow?.excused ?? 0;
  const onDuty = exceptionRow?.onDuty ?? 0;

  const nonPresentOnMarkedDays = late + halfDay + absent + sick + suspended + excused + onDuty;
  const present = Math.max(0, markedDays - nonPresentOnMarkedDays);

  return {
    counts: { present, late, halfDay, absent, sick, suspended, excused, holiday: 0, onDuty },
    workingDays,
    markedDays,
    unmarkedDays,
  };
}

export async function getAttendanceSummaryForStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  month: number,
  year: number
) {
  const db = await getSchoolDB(env, schoolCode);
  const fromDate = `${year}-${month.toString().padStart(2, "0")}-01`;
  const toDate = `${year}-${month.toString().padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;
  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;

  const { counts, workingDays, markedDays, unmarkedDays } =
    await getStudentMonthlyCounts(env, schoolCode, db, userId, fromDate, toDate, datePattern);

  const { effectivePresent, attendancePercentage } = deriveAttendanceStats(counts, markedDays);

  return {
    month, year,
    workingDays,
    markedDays,
    unmarkedDays,
    ...counts,
    effectivePresent,
    attendancePercentage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXED: was calling getStudentMonthlyCounts with the old 3-arg signature.
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

  if (!link) throw new Error("Unauthorized: no parent-child relationship found");

  const fromDate = `${year}-${month.toString().padStart(2, "0")}-01`;
  const toDate = `${year}-${month.toString().padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;
  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  const { counts, workingDays, markedDays, unmarkedDays } = await getStudentMonthlyCounts(
    env, schoolCode, db, childStudentId, fromDate, toDate, datePattern
  );

  const { effectivePresent, attendancePercentage } = deriveAttendanceStats(counts, markedDays);

  return {
    month, year, totalDaysInMonth,
    workingDays, markedDays, unmarkedDays,
    ...counts,
    effectivePresent,
    attendancePercentage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE REPORT (Monthly — whole class or whole school, Staff view)
//
// FIXED: `deriveAttendanceStats(counts, markedDays)` never returned
// `workingDays`/`totalMarkedDays` — those were always undefined. Now the
// calendar-authoritative workingDays is fetched once per distinct
// class-section in the report (parallelised), and unmarkedDays is derived
// the same way as the single-student summary functions.
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
  const fromDate = `${year}-${month.toString().padStart(2, "0")}-01`;
  const toDate = `${year}-${month.toString().padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

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
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,

      markedDays: sql<number>`(
        SELECT COUNT(*) FROM attendance_sessions ases
        WHERE ases.class_section_id = ${schoolStudentEnrollmentsSchema.classSectionId}
          AND ases.date LIKE ${datePattern}
      )`.as("marked_days"),

      late: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.LATE} THEN 1 END)`.as("late"),
      halfDay: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HALF_DAY} THEN 1 END)`.as("half_day"),
      absent: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ABSENT} THEN 1 END)`.as("absent"),
      sick: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SICK} THEN 1 END)`.as("sick"),
      suspended: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.SUSPENDED} THEN 1 END)`.as("suspended"),
      excused: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.EXCUSED} THEN 1 END)`.as("excused"),
      // Legacy field — pre-calendar data may still have per-student HOLIDAY
      // rows. Kept for backward compatibility with historical months; new
      // data will never produce this (markAttendance now rejects it).
      holiday: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.HOLIDAY} THEN 1 END)`.as("holiday"),
      onDuty: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = ${AttendanceStatus.ON_DUTY} THEN 1 END)`.as("on_duty"),
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .leftJoin(
      schoolAttendancesSchema,
      and(
        eq(schoolStudentEnrollmentsSchema.id, schoolAttendancesSchema.enrollmentId),
        sql`${schoolAttendancesSchema.date} LIKE ${datePattern}`
      )
    )
    .where(and(...enrollmentWhere))
    .groupBy(
      schoolStudentEnrollmentsSchema.studentId,
      schoolUsersSchema.name,
      schoolStudentEnrollmentsSchema.rollNumber,
      schoolStudentEnrollmentsSchema.classSectionId
    )
    .orderBy(
      data.classSectionId
        ? sql`CAST(${schoolStudentEnrollmentsSchema.rollNumber} AS INTEGER)`
        : schoolUsersSchema.name
    );

  // Calendar-authoritative working days — one lookup per distinct
  // class-section in this report, not per student row.
  const distinctSectionIds = [...new Set(reportData.map((r: any) => r.classSectionId as number))];
  const workingDaysBySection = new Map<number, number>();
  await Promise.all(
    distinctSectionIds.map(async (csId) => {
      const wd = await countWorkingDaysInRange(env, schoolCode, csId, fromDate, toDate);
      workingDaysBySection.set(csId, wd);
    })
  );

  return reportData.map((row: any) => {
    const markedDays = row.markedDays || 0;
    const late = row.late || 0;
    const halfDay = row.halfDay || 0;
    const absent = row.absent || 0;
    const sick = row.sick || 0;
    const suspended = row.suspended || 0;
    const excused = row.excused || 0;
    const holiday = row.holiday || 0; // legacy, see note above
    const onDuty = row.onDuty || 0;

    const nonPresent = late + halfDay + absent + sick + suspended + excused + holiday + onDuty;
    const present = Math.max(0, markedDays - nonPresent);

    const counts: StatusCounts = {
      present, late, halfDay, absent, sick, suspended, excused, holiday, onDuty,
    };
    const { effectivePresent, attendancePercentage } = deriveAttendanceStats(counts, markedDays);

    const workingDays = workingDaysBySection.get(row.classSectionId) ?? 0;
    const unmarkedDays = Math.max(0, workingDays - markedDays);

    return {
      studentId: row.studentId,
      studentName: row.studentName,
      rollNumber: row.rollNumber ?? null,
      classSectionId: row.classSectionId,
      totalDaysInMonth,
      workingDays,
      markedDays,
      unmarkedDays,
      ...counts,
      effectivePresent,
      attendancePercentage,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE AUDIT LOG (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAttendanceAuditLog(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return db
    .select({
      id: schoolAttendanceAuditLogSchema.id,
      date: schoolAttendanceAuditLogSchema.date,
      oldStatus: schoolAttendanceAuditLogSchema.oldStatus,
      newStatus: schoolAttendanceAuditLogSchema.newStatus,
      changedAt: schoolAttendanceAuditLogSchema.changedAt,
      changedByName: sql<string>`(
        SELECT su.name FROM school_users su
        WHERE su.id = ${schoolAttendanceAuditLogSchema.changedBy}
      )`.as("changed_by_name"),
    })
    .from(schoolAttendanceAuditLogSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(schoolAttendanceAuditLogSchema.enrollmentId, schoolStudentEnrollmentsSchema.id)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        gte(schoolAttendanceAuditLogSchema.date, fromDate),
        lte(schoolAttendanceAuditLogSchema.date, toDate)
      )
    )
    .orderBy(schoolAttendanceAuditLogSchema.changedAt);
}