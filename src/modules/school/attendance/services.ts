import { getSchoolDB } from "../../../db/school-client";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  schoolAttendancesSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
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

  const enrollmentWhere = [eq(schoolStudentEnrollmentsSchema.isActive, true)];
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
    .groupBy(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.name)
    .orderBy(schoolUsersSchema.name);

  return reportData.map((row: any) => ({
    studentId: row.studentId,
    studentName: row.studentName,
    totalDays: row.totalDays,
    present: row.present || 0,
    absent: row.absent || 0,
    late: row.late || 0,
    halfDay: row.halfDay || 0,
    attendancePercentage:
      row.totalDays > 0 ? Math.round((row.present / row.totalDays) * 100) : 0,
  }));
}
