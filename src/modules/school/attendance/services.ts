import { getSchoolDB } from "../../../db/school-client";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  schoolAcademicYearsSchema,
  schoolAttendancesSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";

/**
 * MARK ATTENDANCE (Batch with Upsert)
 *
 * Purpose: Teacher marks attendance for an entire class-section on a specific date.
 *          Uses upsert pattern so teachers can correct mistakes later.
 *
 * How it works:
 * 1. Validates classSectionId exists
 * 2. For each student: finds enrollment via classSectionId
 * 3. Inserts new record or updates existing one
 *
 * @param data.classSectionId - Required
 * @param data.attendances - Array of {studentId, status, notes?}
 * @returns Success message with counts
 */
export async function markAttendance(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any,
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

      if (!enrollment)
        throw new Error(
          `No active enrollment found for student ${att.studentId} in this class-section`
        );

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
        notes: att.notes || null,
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

/**
 * GET ATTENDANCE BY STUDENT
 *
 * Purpose: Returns full attendance history for one student between two dates.
 * Used by student/parent dashboard and teacher reports.
 */
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

/**
 * GET ATTENDANCE BY CLASS-SECTION & DATE
 *
 * Purpose: Shows full class attendance sheet for one date (teacher view).
 */
export async function getAttendanceByClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number,
  date: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolAttendancesSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      status: schoolAttendancesSchema.status,
      notes: schoolAttendancesSchema.notes,
      markedBy: schoolAttendancesSchema.markedBy,
    })
    .from(schoolAttendancesSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolAttendancesSchema.date, date)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber);
}

/**
 * GET ATTENDANCE REPORT (Monthly Summary)
 *
 * Purpose: Generates monthly attendance percentage report for a class-section or single student.
 * Includes present/absent/late/half-day counts and percentage.
 *
 * @param data.classSectionId or data.studentId + month/year
 */
export async function getAttendanceReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const year = data.year || new Date().getFullYear();
  const month = data.month;
  if (!month) throw new Error("Month is required for attendance report");

  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  // ── Resolve current academic year for scoping ─────────────────────────────
  // Without this, students from past years enrolled in the same class-section
  // would appear in the report. We scope to the active academic year only.
  const currentYear = await db
    .select({ id: schoolAcademicYearsSchema.id })
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No active academic year found");

  const enrollmentWhere = [
    eq(schoolStudentEnrollmentsSchema.isActive, true),
    eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id), // ← NEW: scope to current year
  ];

  if (data.classSectionId)
    enrollmentWhere.push(
      eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
    );
  if (data.studentId)
    enrollmentWhere.push(
      eq(schoolStudentEnrollmentsSchema.studentId, data.studentId)
    );

  const reportData = await db
    .select({
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber, // ← NEW: include roll number for sorting
      totalDays: sql<number>`${totalDaysInMonth}`.as("total_days"),
      present:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'PRESENT' THEN 1 END)`.as(
          "present"
        ),
      absent:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'ABSENT' THEN 1 END)`.as(
          "absent"
        ),
      late: sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'LATE' THEN 1 END)`.as(
        "late"
      ),
      halfDay:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'HALF_DAY' THEN 1 END)`.as(
          "half_day"
        ),
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
      schoolStudentEnrollmentsSchema.rollNumber // ← group by roll number too
    )
    .orderBy(
      // ── Sort by roll number when a class-section is selected, else by name ──
      data.classSectionId
        ? sql`CAST(${schoolStudentEnrollmentsSchema.rollNumber} AS INTEGER)`
        : schoolUsersSchema.name
    );

  return reportData.map((row: any) => ({
    studentId: row.studentId,
    studentName: row.studentName,
    rollNumber: row.rollNumber ?? null, // ← NEW: expose to frontend
    totalDays: row.totalDays,
    present: row.present || 0,
    absent: row.absent || 0,
    late: row.late || 0,
    halfDay: row.halfDay || 0,
    attendancePercentage:
      row.totalDays > 0 ? Math.round((row.present / row.totalDays) * 100) : 0,
  }));
}

// ==================== NEW: GET ATTENDANCE FOR STUDENT (SELF VIEW) ====================
/**
 * GET ATTENDANCE BY STUDENT SELF
 *
 * Purpose: Student views their OWN attendance history.
 * Security: userId comes from the validated JWT — no studentId override possible.
 * Used by: /attendance/me endpoint (guarded by attendance.student.view)
 */
export async function getAttendanceByStudentSelf(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,         // From JWT — authoritative, cannot be spoofed
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolAttendancesSchema.id,
      date: schoolAttendancesSchema.date,
      status: schoolAttendancesSchema.status,
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


// ==================== NEW: GET ATTENDANCE SUMMARY FOR STUDENT (SELF) ====================
/**
 * Monthly summary — total days, present, absent, late, halfDay, percentage.
 * Used by the student attendance dashboard card.
 */
export async function getAttendanceSummaryForStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,   // From JWT
  month: number,
  year: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const datePattern = `${year}-${month.toString().padStart(2, "0")}-%`;
  const totalDaysInMonth = new Date(year, month, 0).getDate();

  const rows = await db
    .select({
      present:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'PRESENT' THEN 1 END)`.as("present"),
      absent:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'ABSENT' THEN 1 END)`.as("absent"),
      late:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'LATE' THEN 1 END)`.as("late"),
      halfDay:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'HALF_DAY' THEN 1 END)`.as("half_day"),
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

  const present = rows?.present ?? 0;
  const absent = rows?.absent ?? 0;
  const late = rows?.late ?? 0;
  const halfDay = rows?.halfDay ?? 0;
  const markedDays = present + absent + late + halfDay;

  return {
    month,
    year,
    totalDaysInMonth,
    markedDays,
    present,
    absent,
    late,
    halfDay,
    attendancePercentage:
      markedDays > 0 ? Math.round((present / markedDays) * 100) : 0,
  };
}


// ==================== NEW: GET ATTENDANCE FOR PARENT (CHILD VIEW) ====================
/**
 * GET ATTENDANCE FOR PARENT (CHILD VIEW)
 *
 * Purpose: Parent views their child's attendance.
 * Security:
 *   - parentId comes from JWT (cannot be spoofed).
 *   - childStudentId comes from X-Active-Child-Id header (set by auth-interceptor).
 *   - We verify the parent–child link in student_parents table before returning data.
 *     This prevents a parent from viewing another family's child by manipulating the header.
 *
 * @param parentUserId  - Authenticated parent's userId (from JWT)
 * @param childStudentId - Active child's userId (from X-Active-Child-Id header)
 */
export async function getAttendanceForParentChildView(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number,
  childStudentId: number,
  fromDate: string,
  toDate: string
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Security check: verify parent-child relationship ──────────────────────
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


// ==================== NEW: GET ATTENDANCE SUMMARY FOR PARENT (CHILD VIEW) ====================
/**
 * Monthly summary for the parent's selected child.
 * Same security check as getAttendanceForParentChildView.
 */
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

  const rows = await db
    .select({
      present:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'PRESENT' THEN 1 END)`.as("present"),
      absent:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'ABSENT' THEN 1 END)`.as("absent"),
      late:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'LATE' THEN 1 END)`.as("late"),
      halfDay:
        sql<number>`COUNT(CASE WHEN ${schoolAttendancesSchema.status} = 'HALF_DAY' THEN 1 END)`.as("half_day"),
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

  const present = rows?.present ?? 0;
  const absent = rows?.absent ?? 0;
  const late = rows?.late ?? 0;
  const halfDay = rows?.halfDay ?? 0;
  const markedDays = present + absent + late + halfDay;

  return {
    month,
    year,
    totalDaysInMonth,
    markedDays,
    present,
    absent,
    late,
    halfDay,
    attendancePercentage:
      markedDays > 0 ? Math.round((present / markedDays) * 100) : 0,
  };
}