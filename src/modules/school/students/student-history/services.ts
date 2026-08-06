// src/modules/school/students/history/services.ts
//
// STUDENT HISTORY SERVICE LAYER
// ─────────────────────────────────────────────────────────────────────────────
//
// CORE CONCEPT: "Departed / Alumni" students
// ───────────────────────────────────────────
// A student is considered ACTIVE   → has at least one enrollment where isActive = true
// A student is considered DEPARTED → every enrollment has isActive = false
//                                    (permanently unenrolled, left school, etc.)
//                                    OR the student has no enrollments at all
//                                    (account created but never enrolled)
//
// This module treats both active and departed students equally.
// The school can look up a departed student's FULL history years later —
// every fee payment, exam mark, attendance record, and assignment submission
// is permanently preserved in the DB and returned here.
//
// SEARCH
// ───────
// searchStudents()       — fast autocomplete, matches across 8 fields
// getAllStudentsHistory() — paginated list with rich multi-field search,
//                          status filter (active | departed | all),
//                          sort controls, and per-student summary stats
//
// HISTORY
// ────────
// getStudentHistory()        — full chronological event timeline for one student
// getStudentHistorySummary() — lightweight stats card for one student

import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  parentsSchema,
  schoolAssignmentsSchema,
  schoolAssignmentSubmissionsSchema,
  schoolAttendancesSchema,
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionSubjectsSchema,
  schoolClassSectionsSchema,
  schoolExamMarksSchema,
  schoolExamsSchema,
  schoolFeeConcessionsSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolSubjectsSchema,
  schoolUsersSchema,
  studentsSchema,
  studentParentsSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";
import {
  ABSENT_EQUIVALENT_STATUSES,
  PRESENT_EQUIVALENT_STATUSES,
  NEUTRAL_STATUSES,
} from "../../../../db/schemas/school/school-attendances";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const HistoryEventType = {
  ENROLLED: "ENROLLED",
  UNENROLLED: "UNENROLLED",
  TRANSFERRED: "TRANSFERRED",
  ATTENDANCE_MARKED: "ATTENDANCE_MARKED",
  FEE_PAYMENT: "FEE_PAYMENT",
  FEE_CONCESSION: "FEE_CONCESSION",
  FEE_ASSIGNMENT: "FEE_ASSIGNMENT",
  EXAM_MARKS: "EXAM_MARKS",
  ASSIGNMENT_SUBMISSION: "ASSIGNMENT_SUBMISSION",
  ASSIGNMENT_GRADED: "ASSIGNMENT_GRADED",
  ACCOUNT_CREATED: "ACCOUNT_CREATED",
  PARENT_LINKED: "PARENT_LINKED",
} as const;

export type HistoryEventTypeValue =
  (typeof HistoryEventType)[keyof typeof HistoryEventType];

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryEvent {
  id: string;
  eventType: HistoryEventTypeValue;
  date: string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  academicYear?: { id: number; name: string } | null;
  classSection?: { className: string; sectionName: string } | null;
}

export interface EnrollmentRecord {
  enrollmentId: number;
  academicYearId: number;
  academicYearName: string;
  className: string;
  sectionName: string;
  classSectionId: number;
  rollNumber: string | null;
  enrollmentDate: string | null;
  isActive: boolean;
  unenrollmentType: string | null;
  unenrollmentReason: string | null;
  unenrolledAt: string | null;
}

export interface AttendanceSummary {
  academicYearId: number;
  academicYearName: string;
  className: string;
  sectionName: string;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  lateDays: number;
  halfDays: number;
  excusedDays: number;
  attendancePercentage: number;
}

export interface AcademicPerformanceSummary {
  academicYearId: number;
  academicYearName: string;
  className: string;
  sectionName: string;
  exams: Array<{
    examId: number;
    examName: string;
    examType: string;
    subjectResults: Array<{
      subjectName: string;
      marksObtained: number;
      maxMarks: number;
      grade: string | null;
    }>;
    totalMarks: number;
    totalMaxMarks: number;
    percentage: number;
  }>;
}

export interface FeeSummary {
  academicYearId: number;
  academicYearName: string;
  totalCharged: number;
  totalPaid: number;
  totalConcession: number;
  balance: number;
  paymentCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a list of SQL conditions for multi-field search.
 * Used by both searchStudents() and getAllStudentsHistory().
 *
 * Search priority (all run as OR so any match wins):
 *   1. Exact email match           — highest specificity
 *   2. Exact admission number      — unique school identifier
 *   3. LIKE name                   — most common search
 *   4. LIKE phone / alternate phone
 *   5. LIKE fatherName / motherName / guardianName
 *   6. LIKE rollNumber
 *
 * SQLite LIKE is case-insensitive for ASCII characters.
 * For Unicode (Hindi names etc.) we use LOWER() on both sides.
 */
function buildSearchConditions(params: {
  q?: string;
  name?: string;
  email?: string;
  username?: string;
  phone?: string;
  admissionNumber?: string;
  fatherName?: string;
  motherName?: string;
  rollNumber?: string;
}): any[] {
  const conditions: any[] = [];

  // Universal search term — OR across all fields
  if (params.q && params.q.trim()) {
    const term = `%${params.q.trim().toLowerCase()}%`;
    const exactTerm = params.q.trim().toLowerCase();

    conditions.push(
      or(
        // Exact matches (higher relevance, but OR is fine here)
        sql`LOWER(${schoolUsersSchema.email}) = ${exactTerm}`,
        sql`LOWER(${schoolUsersSchema.username}) = ${exactTerm}`,
        sql`LOWER(${studentsSchema.admissionNumber}) = ${exactTerm}`,
        // Partial matches
        sql`LOWER(${schoolUsersSchema.name}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.username}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.phone}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.alternatePhone}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.fatherName}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.motherName}) LIKE ${term}`,
        sql`LOWER(${schoolUsersSchema.guardianName}) LIKE ${term}`,
        sql`LOWER(${studentsSchema.admissionNumber}) LIKE ${term}`,
        sql`LOWER(${studentsSchema.rollNumber}) LIKE ${term}`
      )
    );
  }

  // Individual field filters (additive AND conditions)
  if (params.name?.trim()) {
    const t = `%${params.name.trim().toLowerCase()}%`;
    conditions.push(sql`LOWER(${schoolUsersSchema.name}) LIKE ${t}`);
  }

  if (params.email?.trim()) {
    const t = `%${params.email.trim().toLowerCase()}%`;
    conditions.push(sql`LOWER(${schoolUsersSchema.email}) LIKE ${t}`);
  }

  // students without an email can still be filtered by username
  if (params.username?.trim()) {
    const t = `%${params.username.trim().toLowerCase()}%`;
    conditions.push(sql`LOWER(${schoolUsersSchema.username}) LIKE ${t}`);
  }

  if (params.phone?.trim()) {
    const t = `%${params.phone.trim()}%`;
    conditions.push(
      or(
        sql`${schoolUsersSchema.phone} LIKE ${t}`,
        sql`${schoolUsersSchema.alternatePhone} LIKE ${t}`
      )
    );
  }

  if (params.admissionNumber?.trim()) {
    const t = `%${params.admissionNumber.trim()}%`;
    conditions.push(sql`LOWER(${studentsSchema.admissionNumber}) LIKE ${t}`);
  }
  if (params.fatherName?.trim()) {
    const t = `%${params.fatherName.trim().toLowerCase()}%`;
    conditions.push(sql`LOWER(${schoolUsersSchema.fatherName}) LIKE ${t}`);
  }
  if (params.motherName?.trim()) {
    const t = `%${params.motherName.trim().toLowerCase()}%`;
    conditions.push(sql`LOWER(${schoolUsersSchema.motherName}) LIKE ${t}`);
  }
  if (params.rollNumber?.trim()) {
    const t = `%${params.rollNumber.trim()}%`;
    conditions.push(sql`LOWER(${studentsSchema.rollNumber}) LIKE ${t}`);
  }

  return conditions;
}

/**
 * Determines whether to apply an active/departed filter as a SQL subquery.
 *
 * "active"   → studentId IN (SELECT studentId FROM enrollments WHERE isActive = 1)
 * "departed" → studentId NOT IN (SELECT studentId FROM enrollments WHERE isActive = 1)
 * "all"      → no filter
 */
function buildStatusCondition(
  status: "active" | "departed" | "all"
): any | null {
  if (status === "active") {
    return sql`${schoolUsersSchema.id} IN (
      SELECT student_id FROM student_enrollments WHERE is_active = 1
    )`;
  }
  if (status === "departed") {
    return sql`${schoolUsersSchema.id} NOT IN (
      SELECT student_id FROM student_enrollments WHERE is_active = 1
    )`;
  }
  return null; // "all" — no filter
}

// ─────────────────────────────────────────────────────────────────────────────
// searchStudents  — fast autocomplete
// ─────────────────────────────────────────────────────────────────────────────

export interface StudentSearchResult {
  id: number;
  name: string;
  email: string | null;   // CHANGED  was `string`, schema made it nullable
  username: string;       // always present, NOT NULL in schema
  phone: string | null;
  admissionNumber: string | null;
  avatarUrl: string | null;
  isActive: boolean; // account is active
  isDeparted: boolean; // no active enrollment = left school
  fatherName: string | null;
  gender: string | null;
  currentEnrollment: {
    className: string;
    sectionName: string;
    academicYearName: string;
  } | null;
  lastEnrollment: {
    className: string;
    sectionName: string;
    academicYearName: string;
    unenrolledAt: string | null;
    unenrollmentType: string | null;
  } | null;
}

export async function searchStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  options: {
    q: string;
    status: "active" | "departed" | "all";
    limit: number;
  }
): Promise<StudentSearchResult[]> {
  const db = await getSchoolDB(env, schoolCode);

  const baseConditions: any[] = [eq(schoolUsersSchema.primaryRole, "STUDENT")];

  const searchConditions = buildSearchConditions({ q: options.q });
  if (searchConditions.length > 0) {
    baseConditions.push(...searchConditions);
  }

  const statusCond = buildStatusCondition(options.status);
  if (statusCond) baseConditions.push(statusCond);

  const rows = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      username: schoolUsersSchema.username,
      phone: schoolUsersSchema.phone,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      fatherName: schoolUsersSchema.fatherName,
      gender: schoolUsersSchema.gender,
      admissionNumber: studentsSchema.admissionNumber,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(studentsSchema.userId, schoolUsersSchema.id))
    .where(and(...baseConditions))
    .orderBy(schoolUsersSchema.name)
    .limit(options.limit)
    .all();

  if (rows.length === 0) return [];

  const studentIds = rows.map((r) => r.id);

  // Fetch active enrollment for each student
  const activeEnrollments = await db
    .select({
      studentId: schoolStudentEnrollmentsSchema.studentId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      yearName: schoolAcademicYearsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(
      and(
        inArray(schoolStudentEnrollmentsSchema.studentId, studentIds),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .all();

  // Fetch most recent past enrollment (for departed students)
  const lastEnrollments = await db
    .select({
      studentId: schoolStudentEnrollmentsSchema.studentId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      yearName: schoolAcademicYearsSchema.name,
      unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(
      and(
        inArray(schoolStudentEnrollmentsSchema.studentId, studentIds),
        eq(schoolStudentEnrollmentsSchema.isActive, false)
      )
    )
    .orderBy(desc(schoolStudentEnrollmentsSchema.unenrolledAt))
    .all();

  // Build lookups
  const activeByStudent = new Map(
    activeEnrollments.map((e) => [e.studentId, e])
  );

  // Last enrollment per student (first row after ORDER BY DESC)
  const lastByStudent = new Map<number, (typeof lastEnrollments)[0]>();
  for (const e of lastEnrollments) {
    if (!lastByStudent.has(e.studentId)) lastByStudent.set(e.studentId, e);
  }

  return rows.map((r) => {
    const active = activeByStudent.get(r.id);
    const last = lastByStudent.get(r.id);
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      username: r.username,
      phone: r.phone || null,
      admissionNumber: r.admissionNumber || null,
      avatarUrl: r.avatarUrl || null,
      isActive: r.isActive,
      isDeparted: !active,
      fatherName: r.fatherName || null,
      gender: r.gender || null,
      currentEnrollment: active
        ? {
            className: active.className,
            sectionName: active.sectionName,
            academicYearName: active.yearName,
          }
        : null,
      lastEnrollment:
        !active && last
          ? {
              className: last.className,
              sectionName: last.sectionName,
              academicYearName: last.yearName,
              unenrolledAt: last.unenrolledAt,
              unenrollmentType: last.unenrollmentType,
            }
          : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getAllStudentsHistory — paginated list with stats
// ─────────────────────────────────────────────────────────────────────────────

export async function getAllStudentsHistory(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  options: {
    q?: string;
    name?: string;
    email?: string;
    username?: string; 
    phone?: string;
    admissionNumber?: string;
    fatherName?: string;
    motherName?: string;
    rollNumber?: string;
    status: "active" | "departed" | "all";
    academicYearId?: number;
    sortBy: "name" | "admissionDate" | "createdAt";
    sortOrder: "asc" | "desc";
    page: number;
    limit: number;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Build WHERE conditions ────────────────────────────────────────────────
  const baseConditions: any[] = [eq(schoolUsersSchema.primaryRole, "STUDENT")];

  const searchConditions = buildSearchConditions({
    q: options.q,
    name: options.name,
    email: options.email,
    username: options.username, 
    phone: options.phone,
    admissionNumber: options.admissionNumber,
    fatherName: options.fatherName,
    motherName: options.motherName,
    rollNumber: options.rollNumber,
  });
  if (searchConditions.length > 0) {
    baseConditions.push(...searchConditions);
  }

  // Status filter (active / departed / all)
  const statusCond = buildStatusCondition(options.status);
  if (statusCond) baseConditions.push(statusCond);

  // Academic year scope: only students who were enrolled in that year
  if (options.academicYearId) {
    baseConditions.push(
      sql`${schoolUsersSchema.id} IN (
        SELECT student_id FROM student_enrollments
        WHERE academic_year_id = ${options.academicYearId}
      )`
    );
  }

  // ── Sort column ───────────────────────────────────────────────────────────
  const sortCol =
    options.sortBy === "admissionDate"
      ? studentsSchema.admissionDate
      : options.sortBy === "createdAt"
      ? schoolUsersSchema.createdAt
      : schoolUsersSchema.name;

  const sortDir = options.sortOrder === "desc" ? desc(sortCol) : asc(sortCol);

  // ── Total count ───────────────────────────────────────────────────────────
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(studentsSchema.userId, schoolUsersSchema.id))
    .where(and(...baseConditions));

  const totalPages = Math.ceil(total / options.limit);
  const offset = (options.page - 1) * options.limit;

  // ── Fetch page ────────────────────────────────────────────────────────────
  const studentRows = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      username: schoolUsersSchema.username,
      phone: schoolUsersSchema.phone,
      alternatePhone: schoolUsersSchema.alternatePhone,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      createdAt: schoolUsersSchema.createdAt,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      fatherName: schoolUsersSchema.fatherName,
      motherName: schoolUsersSchema.motherName,
      guardianName: schoolUsersSchema.guardianName,
      admissionNumber: studentsSchema.admissionNumber,
      rollNumber: studentsSchema.rollNumber,
      admissionDate: studentsSchema.admissionDate,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(studentsSchema.userId, schoolUsersSchema.id))
    .where(and(...baseConditions))
    .orderBy(sortDir)
    .limit(options.limit)
    .offset(offset)
    .all();

  if (studentRows.length === 0) {
    return {
      students: [],
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages,
      },
    };
  }

  const studentIds = studentRows.map((s) => s.id);

  // ── Bulk: all enrollments for these students ──────────────────────────────
  const allEnrollments = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      isActive: schoolStudentEnrollmentsSchema.isActive,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
      yearName: schoolAcademicYearsSchema.name,
      yearStartDate: schoolAcademicYearsSchema.startDate,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(inArray(schoolStudentEnrollmentsSchema.studentId, studentIds))
    .orderBy(desc(schoolAcademicYearsSchema.startDate))
    .all();

  // Group by studentId
  const enrollmentsByStudent = new Map<number, typeof allEnrollments>();
  for (const e of allEnrollments) {
    if (!enrollmentsByStudent.has(e.studentId))
      enrollmentsByStudent.set(e.studentId, []);
    enrollmentsByStudent.get(e.studentId)!.push(e);
  }

  const allEnrollmentIds = allEnrollments.map((e) => e.id);

  // ── Bulk: attendance aggregation ──────────────────────────────────────────
  type AttAgg = { enrollmentId: number; status: string; cnt: number };
  let attAgg: AttAgg[] = [];
  if (allEnrollmentIds.length > 0) {
    attAgg = (await db
      .select({
        enrollmentId: schoolAttendancesSchema.enrollmentId,
        status: schoolAttendancesSchema.status,
        cnt: sql<number>`count(*)`,
      })
      .from(schoolAttendancesSchema)
      .where(inArray(schoolAttendancesSchema.enrollmentId, allEnrollmentIds))
      .groupBy(
        schoolAttendancesSchema.enrollmentId,
        schoolAttendancesSchema.status
      )
      .all()) as AttAgg[];
  }

  const attByEnrollment = new Map<number, AttAgg[]>();
  for (const row of attAgg) {
    if (!attByEnrollment.has(row.enrollmentId))
      attByEnrollment.set(row.enrollmentId, []);
    attByEnrollment.get(row.enrollmentId)!.push(row);
  }

  // ── Bulk: fee aggregation ─────────────────────────────────────────────────
  type FeeAgg = {
    enrollmentId: number;
    totalPaid: number;
    paymentCount: number;
  };
  let feeAgg: FeeAgg[] = [];
  if (allEnrollmentIds.length > 0) {
    feeAgg = (await db
      .select({
        enrollmentId: schoolFeePaymentsSchema.enrollmentId,
        totalPaid: sql<number>`coalesce(sum(${schoolFeePaymentsSchema.amountPaid}), 0)`,
        paymentCount: sql<number>`count(*)`,
      })
      .from(schoolFeePaymentsSchema)
      .where(
        and(
          inArray(schoolFeePaymentsSchema.enrollmentId, allEnrollmentIds),
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      )
      .groupBy(schoolFeePaymentsSchema.enrollmentId)
      .all()) as FeeAgg[];
  }

  const feeByEnrollment = new Map<number, FeeAgg>();
  for (const row of feeAgg) feeByEnrollment.set(row.enrollmentId, row);

  // ── Bulk: exam marks count ────────────────────────────────────────────────
  type MarkAgg = { enrollmentId: number; cnt: number };
  let markAgg: MarkAgg[] = [];
  if (allEnrollmentIds.length > 0) {
    markAgg = (await db
      .select({
        enrollmentId: schoolExamMarksSchema.enrollmentId,
        cnt: sql<number>`count(*)`,
      })
      .from(schoolExamMarksSchema)
      .where(inArray(schoolExamMarksSchema.enrollmentId, allEnrollmentIds))
      .groupBy(schoolExamMarksSchema.enrollmentId)
      .all()) as MarkAgg[];
  }

  const marksByEnrollment = new Map<number, number>();
  for (const row of markAgg)
    marksByEnrollment.set(
      row.enrollmentId,
      (marksByEnrollment.get(row.enrollmentId) ?? 0) + row.cnt
    );

  // ── Assemble result ───────────────────────────────────────────────────────
  const students = studentRows.map((s) => {
    const enrollments = enrollmentsByStudent.get(s.id) ?? [];
    const activeEnrollment = enrollments.find((e) => e.isActive);
    // Most recent past enrollment (already sorted DESC by yearStartDate)
    const lastPastEnrollment = enrollments.find((e) => !e.isActive);
    const isDeparted = !activeEnrollment;

    // Attendance across ALL years
    let workingDays = 0;
    let present = 0;
    let absent = 0;
    for (const enr of enrollments) {
      const rows = attByEnrollment.get(enr.id) ?? [];
      for (const row of rows) {
        if (NEUTRAL_STATUSES.includes(row.status as any)) continue;
        workingDays += row.cnt;
        if (PRESENT_EQUIVALENT_STATUSES.includes(row.status as any)) {
          present += row.status === "HALF_DAY" ? row.cnt * 0.5 : row.cnt;
        } else if (ABSENT_EQUIVALENT_STATUSES.includes(row.status as any)) {
          absent += row.cnt;
        }
      }
    }

    const attendancePercentage =
      workingDays > 0
        ? Math.round((present / workingDays) * 100 * 10) / 10
        : null;

    // Fees across ALL years
    let totalFeePaid = 0;
    for (const enr of enrollments) {
      const fd = feeByEnrollment.get(enr.id);
      if (fd) totalFeePaid += fd.totalPaid;
    }

    // Exam marks across ALL years
    let totalExamMarks = 0;
    for (const enr of enrollments) {
      totalExamMarks += marksByEnrollment.get(enr.id) ?? 0;
    }

    return {
      id: s.id,
      name: s.name,
      email: s.email,
      username: s.username, 
      phone: s.phone || null,
      alternatePhone: s.alternatePhone || null,
      avatarUrl: s.avatarUrl || null,
      isActive: s.isActive,
      isDeparted,
      createdAt: s.createdAt,
      gender: s.gender || null,
      dateOfBirth: s.dateOfBirth || null,
      fatherName: s.fatherName || null,
      motherName: s.motherName || null,
      guardianName: s.guardianName || null,
      admissionNumber: s.admissionNumber || null,
      rollNumber: s.rollNumber || null,
      admissionDate: s.admissionDate || null,
      totalYearsEnrolled: enrollments.length,
      // Current enrollment (null for departed students)
      currentEnrollment: activeEnrollment
        ? {
            className: activeEnrollment.className,
            sectionName: activeEnrollment.sectionName,
            academicYearName: activeEnrollment.yearName,
          }
        : null,
      // Last known class (useful for departed student display)
      lastEnrollment:
        isDeparted && lastPastEnrollment
          ? {
              className: lastPastEnrollment.className,
              sectionName: lastPastEnrollment.sectionName,
              academicYearName: lastPastEnrollment.yearName,
              unenrolledAt: lastPastEnrollment.unenrolledAt,
              unenrollmentType: lastPastEnrollment.unenrollmentType,
            }
          : null,
      stats: {
        workingDays,
        presentDays: present,
        absentDays: absent,
        attendancePercentage,
        totalFeePaidRupees: totalFeePaid / 100,
        totalExamMarksEntered: totalExamMarks,
      },
    };
  });

  return {
    students,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getStudentHistorySummary — lightweight stats card for one student
// ─────────────────────────────────────────────────────────────────────────────

export async function getStudentHistorySummary(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const studentRow = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      username: schoolUsersSchema.username,
      primaryRole: schoolUsersSchema.primaryRole,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      createdAt: schoolUsersSchema.createdAt,
      fatherName: schoolUsersSchema.fatherName,
      motherName: schoolUsersSchema.motherName,
      guardianName: schoolUsersSchema.guardianName,
      phone: schoolUsersSchema.phone,
      alternatePhone: schoolUsersSchema.alternatePhone,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      addressLineOne: schoolUsersSchema.addressLineOne,
      city: schoolUsersSchema.city,
      state: schoolUsersSchema.state,
      admissionNumber: studentsSchema.admissionNumber,
      admissionDate: studentsSchema.admissionDate,
      rollNumber: studentsSchema.rollNumber,
      medicalInfo: studentsSchema.medicalInfo,
      pen: studentsSchema.pen,
      apaarId: studentsSchema.apaarId,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(studentsSchema.userId, schoolUsersSchema.id))
    .where(eq(schoolUsersSchema.id, studentId))
    .get();

  if (!studentRow) return null;

  // All enrollments — ordered newest first
  const enrollments = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      isActive: schoolStudentEnrollmentsSchema.isActive,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
      unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
      unenrollmentReason: schoolStudentEnrollmentsSchema.unenrollmentReason,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      yearName: schoolAcademicYearsSchema.name,
      yearStartDate: schoolAcademicYearsSchema.startDate,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId))
    .orderBy(desc(schoolAcademicYearsSchema.startDate))
    .all();

  const activeEnrollment = enrollments.find((e) => e.isActive);
  const isDeparted = !activeEnrollment;
  const lastPastEnrollment = enrollments.find((e) => !e.isActive);
  const enrollmentIds = enrollments.map((e) => e.id);

  // Enrollment history timeline (for the card — each year the student was here)
  const enrollmentHistory = enrollments.map((e) => ({
    academicYearName: e.yearName,
    className: e.className,
    sectionName: e.sectionName,
    rollNumber: e.rollNumber,
    enrollmentDate: e.enrollmentDate,
    isActive: e.isActive,
    unenrolledAt: e.unenrolledAt,
    unenrollmentType: e.unenrollmentType,
    unenrollmentReason: e.unenrollmentReason,
  }));

  // Fee stats (all time)
  let totalFeePaid = 0;
  let totalFeeCharged = 0;
  if (enrollmentIds.length > 0) {
    const [{ total }] = await db
      .select({
        total: sql<number>`coalesce(sum(${schoolFeePaymentsSchema.amountPaid}), 0)`,
      })
      .from(schoolFeePaymentsSchema)
      .where(
        and(
          inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds),
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      );
    totalFeePaid = total;
  }

  // Attendance (all time)
  let workingDays = 0;
  let present = 0;
  let absent = 0;
  if (enrollmentIds.length > 0) {
    const attRows = (await db
      .select({
        status: schoolAttendancesSchema.status,
        cnt: sql<number>`count(*)`,
      })
      .from(schoolAttendancesSchema)
      .where(inArray(schoolAttendancesSchema.enrollmentId, enrollmentIds))
      .groupBy(schoolAttendancesSchema.status)
      .all()) as { status: string; cnt: number }[];

    for (const row of attRows) {
      const s = row.status;
      if (NEUTRAL_STATUSES.includes(s as any)) continue;
      workingDays += row.cnt;
      if (PRESENT_EQUIVALENT_STATUSES.includes(s as any)) {
        present += s === "HALF_DAY" ? row.cnt * 0.5 : row.cnt;
      } else if (ABSENT_EQUIVALENT_STATUSES.includes(s as any)) {
        absent += row.cnt;
      }
    }
  }

  // Exam marks count
  let totalExamMarks = 0;
  if (enrollmentIds.length > 0) {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(schoolExamMarksSchema)
      .where(inArray(schoolExamMarksSchema.enrollmentId, enrollmentIds));
    totalExamMarks = total;
  }

  // Linked parents
  const linkedParents = await db
    .select({
      parentId: studentParentsSchema.parentId,
      parentName: schoolUsersSchema.name,
      parentEmail: schoolUsersSchema.email,
      parentUsername: schoolUsersSchema.username,
      parentPhone: schoolUsersSchema.phone,
      relationship: studentParentsSchema.relationship,
      isPrimary: studentParentsSchema.isPrimary,
    })
    .from(studentParentsSchema)
    .innerJoin(
      parentsSchema,
      eq(studentParentsSchema.parentId, parentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(parentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(studentParentsSchema.studentId, studentId))
    .all();

  const attendancePercentage =
    workingDays > 0
      ? Math.round((present / workingDays) * 100 * 10) / 10
      : null;

  return {
    student: {
      id: studentRow.id,
      name: studentRow.name,
      email: studentRow.email,
      phone: studentRow.phone || null,
      alternatePhone: studentRow.alternatePhone || null,
      avatarUrl: studentRow.avatarUrl || null,
      isActive: studentRow.isActive,
      isDeparted,
      createdAt: studentRow.createdAt,
      gender: studentRow.gender || null,
      dateOfBirth: studentRow.dateOfBirth || null,
      fatherName: studentRow.fatherName || null,
      motherName: studentRow.motherName || null,
      guardianName: studentRow.guardianName || null,
      addressLineOne: studentRow.addressLineOne || null,
      city: studentRow.city || null,
      state: studentRow.state || null,
      admissionNumber: studentRow.admissionNumber || null,
      admissionDate: studentRow.admissionDate || null,
      rollNumber: studentRow.rollNumber || null,
      medicalInfo: studentRow.medicalInfo || null,
      pen: studentRow.pen || null,
      apaarId: studentRow.apaarId || null,
    },
    currentEnrollment: activeEnrollment
      ? {
          className: activeEnrollment.className,
          sectionName: activeEnrollment.sectionName,
          academicYearName: activeEnrollment.yearName,
          rollNumber: activeEnrollment.rollNumber,
        }
      : null,
    lastEnrollment:
      isDeparted && lastPastEnrollment
        ? {
            className: lastPastEnrollment.className,
            sectionName: lastPastEnrollment.sectionName,
            academicYearName: lastPastEnrollment.yearName,
            unenrolledAt: lastPastEnrollment.unenrolledAt,
            unenrollmentType: lastPastEnrollment.unenrollmentType,
            unenrollmentReason: lastPastEnrollment.unenrollmentReason,
          }
        : null,
    enrollmentHistory,
    linkedParents,
    stats: {
      totalYearsEnrolled: enrollments.length,
      workingDays,
      presentDays: present,
      absentDays: absent,
      attendancePercentage,
      totalFeePaidRupees: totalFeePaid / 100,
      totalExamMarksEntered: totalExamMarks,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getStudentHistory — full paginated timeline for one student
// Works identically for active AND departed students.
// ─────────────────────────────────────────────────────────────────────────────

export async function getStudentHistory(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  options: {
    academicYearId?: number;
    eventTypeFilter?: Set<string> | null;
    dateFrom?: string;
    dateTo?: string;
    page: number;
    limit: number;
  }
): Promise<{
  student: any;
  isDeparted: boolean;
  enrollments: EnrollmentRecord[];
  attendanceSummaries: AttendanceSummary[];
  academicPerformance: AcademicPerformanceSummary[];
  feeSummaries: FeeSummary[];
  events: HistoryEvent[];
  pagination: {
    page: number;
    limit: number;
    totalEvents: number;
    totalPages: number;
  };
} | null> {
  const db = await getSchoolDB(env, schoolCode);
  const { academicYearId, eventTypeFilter, dateFrom, dateTo, page, limit } =
    options;

  // ── Student core record ───────────────────────────────────────────────────
  const studentRow = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      username: schoolUsersSchema.username, 
      primaryRole: schoolUsersSchema.primaryRole,
      avatarUrl: schoolUsersSchema.avatarUrl,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      fatherName: schoolUsersSchema.fatherName,
      motherName: schoolUsersSchema.motherName,
      guardianName: schoolUsersSchema.guardianName,
      phone: schoolUsersSchema.phone,
      isActive: schoolUsersSchema.isActive,
      createdAt: schoolUsersSchema.createdAt,
      admissionNumber: studentsSchema.admissionNumber,
      rollNumber: studentsSchema.rollNumber,
      admissionDate: studentsSchema.admissionDate,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(studentsSchema.userId, schoolUsersSchema.id))
    .where(eq(schoolUsersSchema.id, studentId))
    .get();

  if (!studentRow) return null;

  // ── All enrollments ───────────────────────────────────────────────────────
  const enrollmentConditions: any[] = [
    eq(schoolStudentEnrollmentsSchema.studentId, studentId),
  ];
  if (academicYearId) {
    enrollmentConditions.push(
      eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId)
    );
  }

  const enrollmentRows = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
      isActive: schoolStudentEnrollmentsSchema.isActive,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
      unenrollmentReason: schoolStudentEnrollmentsSchema.unenrollmentReason,
      unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
      yearName: schoolAcademicYearsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(and(...enrollmentConditions))
    .orderBy(desc(schoolAcademicYearsSchema.startDate))
    .all();

  const isDeparted = !enrollmentRows.some((e) => e.isActive);
  const enrollmentIds = enrollmentRows.map((e) => e.id);

  const enrollments: EnrollmentRecord[] = enrollmentRows.map((e) => ({
    enrollmentId: e.id,
    academicYearId: e.academicYearId,
    academicYearName: e.yearName,
    className: e.className,
    sectionName: e.sectionName,
    classSectionId: e.classSectionId,
    rollNumber: e.rollNumber,
    enrollmentDate: e.enrollmentDate,
    isActive: e.isActive,
    unenrollmentType: e.unenrollmentType,
    unenrollmentReason: e.unenrollmentReason,
    unenrolledAt: e.unenrolledAt,
  }));

  // ── Summaries ─────────────────────────────────────────────────────────────
  const attendanceSummaries = await buildAttendanceSummaries(
    db,
    enrollmentRows,
    enrollmentIds
  );
  const academicPerformance = await buildAcademicPerformance(
    db,
    enrollmentRows,
    enrollmentIds
  );
  const feeSummaries = await buildFeeSummaries(
    db,
    enrollmentRows,
    enrollmentIds
  );

  // ── Build event timeline ──────────────────────────────────────────────────
  const allEvents: HistoryEvent[] = [];

  const shouldInclude = (type: HistoryEventTypeValue) => {
    if (!eventTypeFilter) return true;
    if (eventTypeFilter.has(type)) return true;
    if (
      eventTypeFilter.has("ENROLLMENT") &&
      [
        HistoryEventType.ENROLLED,
        HistoryEventType.UNENROLLED,
        HistoryEventType.TRANSFERRED,
      ].includes(type as any)
    )
      return true;
    if (
      eventTypeFilter.has("ATTENDANCE") &&
      type === HistoryEventType.ATTENDANCE_MARKED
    )
      return true;
    if (
      eventTypeFilter.has("FEE") &&
      [
        HistoryEventType.FEE_PAYMENT,
        HistoryEventType.FEE_CONCESSION,
        HistoryEventType.FEE_ASSIGNMENT,
      ].includes(type as any)
    )
      return true;
    if (eventTypeFilter.has("EXAM") && type === HistoryEventType.EXAM_MARKS)
      return true;
    if (
      eventTypeFilter.has("ASSIGNMENT") &&
      [
        HistoryEventType.ASSIGNMENT_SUBMISSION,
        HistoryEventType.ASSIGNMENT_GRADED,
      ].includes(type as any)
    )
      return true;
    if (
      eventTypeFilter.has("PROFILE") &&
      [
        HistoryEventType.ACCOUNT_CREATED,
        HistoryEventType.PARENT_LINKED,
      ].includes(type as any)
    )
      return true;
    return false;
  };

  // Account created
  if (shouldInclude(HistoryEventType.ACCOUNT_CREATED)) {
    allEvents.push({
      id: `profile-created-${studentId}`,
      eventType: HistoryEventType.ACCOUNT_CREATED,
      date: studentRow.createdAt,
      title: "Student Account Created",
      description: `Account created for ${studentRow.name}${
        studentRow.admissionNumber
          ? ` (Admission No: ${studentRow.admissionNumber})`
          : ""
      }`,
      metadata: {
        admissionNumber: studentRow.admissionNumber,
        admissionDate: studentRow.admissionDate,
      },
    });
  }

  // Parent links
  if (shouldInclude(HistoryEventType.PARENT_LINKED)) {
    const parentLinks = await db
      .select({
        id: studentParentsSchema.id,
        parentId: studentParentsSchema.parentId,
        relationship: studentParentsSchema.relationship,
        isPrimary: studentParentsSchema.isPrimary,
        parentName: schoolUsersSchema.name,
        parentEmail: schoolUsersSchema.email,
        parentUsername: schoolUsersSchema.username, 
        parentPhone: schoolUsersSchema.phone,
      })
      .from(studentParentsSchema)
      .innerJoin(
        parentsSchema,
        eq(studentParentsSchema.parentId, parentsSchema.userId)
      )
      .innerJoin(
        schoolUsersSchema,
        eq(parentsSchema.userId, schoolUsersSchema.id)
      )
      .where(eq(studentParentsSchema.studentId, studentId))
      .all();

    for (const link of parentLinks) {
      allEvents.push({
        id: `parent-linked-${link.id}`,
        eventType: HistoryEventType.PARENT_LINKED,
        date: studentRow.createdAt,
        title: "Parent / Guardian Linked",
        description: `${link.parentName} linked as ${link.relationship}${
          link.isPrimary ? " (Primary)" : ""
        }`,
        metadata: {
          parentId: link.parentId,
          parentName: link.parentName,
          parentEmail: link.parentEmail,
          parentUsername: link.parentUsername,
          parentPhone: link.parentPhone,
          relationship: link.relationship,
          isPrimary: link.isPrimary,
        },
      });
    }
  }

  // Enrollment lifecycle events
  const enrollmentEventsWanted =
    shouldInclude(HistoryEventType.ENROLLED) ||
    shouldInclude(HistoryEventType.UNENROLLED) ||
    shouldInclude(HistoryEventType.TRANSFERRED);

  if (enrollmentEventsWanted) {
    for (const enr of enrollmentRows) {
      const label = `${enr.className} — ${enr.sectionName}`;
      const yearCtx = { id: enr.academicYearId, name: enr.yearName };
      const csCtx = { className: enr.className, sectionName: enr.sectionName };

      if (shouldInclude(HistoryEventType.ENROLLED) && enr.enrollmentDate) {
        allEvents.push({
          id: `enrolled-${enr.id}`,
          eventType: HistoryEventType.ENROLLED,
          date: enr.enrollmentDate,
          title: "Enrolled",
          description: `Enrolled in ${label} for academic year ${enr.yearName}`,
          metadata: { enrollmentId: enr.id, rollNumber: enr.rollNumber },
          academicYear: yearCtx,
          classSection: csCtx,
        });
      }

      if (!enr.isActive && enr.unenrolledAt) {
        const isTransfer = enr.unenrollmentType === "TRANSFERRED_OUT";
        if (isTransfer && shouldInclude(HistoryEventType.TRANSFERRED)) {
          allEvents.push({
            id: `transferred-${enr.id}`,
            eventType: HistoryEventType.TRANSFERRED,
            date: enr.unenrolledAt,
            title: "Transferred Out",
            description: `Transferred out of ${label}${
              enr.unenrollmentReason
                ? `. Reason: ${enr.unenrollmentReason}`
                : ""
            }`,
            metadata: {
              enrollmentId: enr.id,
              unenrollmentReason: enr.unenrollmentReason,
            },
            academicYear: yearCtx,
            classSection: csCtx,
          });
        }
        if (!isTransfer && shouldInclude(HistoryEventType.UNENROLLED)) {
          allEvents.push({
            id: `unenrolled-${enr.id}`,
            eventType: HistoryEventType.UNENROLLED,
            date: enr.unenrolledAt,
            title: `Unenrolled (${enr.unenrollmentType ?? "PERMANENT"})`,
            description: `Unenrolled from ${label}${
              enr.unenrollmentReason
                ? `. Reason: ${enr.unenrollmentReason}`
                : ""
            }`,
            metadata: {
              enrollmentId: enr.id,
              unenrollmentType: enr.unenrollmentType,
              unenrollmentReason: enr.unenrollmentReason,
            },
            academicYear: yearCtx,
            classSection: csCtx,
          });
        }
      }
    }
  }

  // Attendance events (only notable — not PRESENT to avoid noise)
  if (
    enrollmentIds.length > 0 &&
    shouldInclude(HistoryEventType.ATTENDANCE_MARKED)
  ) {
    const attConditions: any[] = [
      inArray(schoolAttendancesSchema.enrollmentId, enrollmentIds),
      inArray(schoolAttendancesSchema.status, [
        "ABSENT",
        "LATE",
        "HALF_DAY",
        "SICK",
        "SUSPENDED",
        "EXCUSED",
        "ON_DUTY",
      ] as any),
    ];
    if (dateFrom)
      attConditions.push(gte(schoolAttendancesSchema.date, dateFrom));
    if (dateTo) attConditions.push(lte(schoolAttendancesSchema.date, dateTo));

    const attRows = await db
      .select({
        id: schoolAttendancesSchema.id,
        enrollmentId: schoolAttendancesSchema.enrollmentId,
        date: schoolAttendancesSchema.date,
        status: schoolAttendancesSchema.status,
        halfDaySession: schoolAttendancesSchema.halfDaySession,
        notes: schoolAttendancesSchema.notes,
        markedByName: schoolUsersSchema.name,
      })
      .from(schoolAttendancesSchema)
      .leftJoin(
        schoolUsersSchema,
        eq(schoolAttendancesSchema.markedBy, schoolUsersSchema.id)
      )
      .where(and(...attConditions))
      .orderBy(desc(schoolAttendancesSchema.date))
      .all();

    const enrollmentCtx = new Map(
      enrollmentRows.map((e) => [
        e.id,
        {
          className: e.className,
          sectionName: e.sectionName,
          yearId: e.academicYearId,
          yearName: e.yearName,
        },
      ])
    );

    for (const att of attRows) {
      const ctx = enrollmentCtx.get(att.enrollmentId);
      allEvents.push({
        id: `attendance-${att.id}`,
        eventType: HistoryEventType.ATTENDANCE_MARKED,
        date: att.date,
        title: `Attendance: ${att.status.replace(/_/g, " ")}`,
        description: att.notes
          ? `${att.status} on ${att.date}. Note: ${att.notes}`
          : `${att.status} on ${att.date}`,
        metadata: {
          status: att.status,
          halfDaySession: att.halfDaySession,
          notes: att.notes,
          markedBy: att.markedByName,
        },
        academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
        classSection: ctx
          ? { className: ctx.className, sectionName: ctx.sectionName }
          : null,
      });
    }
  }

  // Fee payment events
  if (enrollmentIds.length > 0 && shouldInclude(HistoryEventType.FEE_PAYMENT)) {
    const feeConditions: any[] = [
      inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds),
    ];
    if (dateFrom)
      feeConditions.push(gte(schoolFeePaymentsSchema.paymentDate, dateFrom));
    if (dateTo)
      feeConditions.push(lte(schoolFeePaymentsSchema.paymentDate, dateTo));

    const feeRows = await db
      .select({
        id: schoolFeePaymentsSchema.id,
        enrollmentId: schoolFeePaymentsSchema.enrollmentId,
        paymentDate: schoolFeePaymentsSchema.paymentDate,
        amountPaid: schoolFeePaymentsSchema.amountPaid,
        paymentMethod: schoolFeePaymentsSchema.paymentMethod,
        receiptNumber: schoolFeePaymentsSchema.receiptNumber,
        notes: schoolFeePaymentsSchema.notes,
        isVoid: schoolFeePaymentsSchema.isVoid,
        feeType: schoolFeeStructuresSchema.feeType,
        feeMonth: schoolFeeStructuresSchema.feeMonth,
        recordedByName: schoolUsersSchema.name,
      })
      .from(schoolFeePaymentsSchema)
      .leftJoin(
        schoolFeeStructuresSchema,
        eq(schoolFeePaymentsSchema.feeStructureId, schoolFeeStructuresSchema.id)
      )
      .leftJoin(
        schoolUsersSchema,
        eq(schoolFeePaymentsSchema.recordedBy, schoolUsersSchema.id)
      )
      .where(and(...feeConditions))
      .orderBy(desc(schoolFeePaymentsSchema.paymentDate))
      .all();

    const enrollmentCtx = new Map(
      enrollmentRows.map((e) => [
        e.id,
        {
          className: e.className,
          sectionName: e.sectionName,
          yearId: e.academicYearId,
          yearName: e.yearName,
        },
      ])
    );

    for (const fee of feeRows) {
      const ctx = enrollmentCtx.get(fee.enrollmentId);
      const amt = `₹${(fee.amountPaid / 100).toLocaleString("en-IN")}`;
      const feeLabel = fee.feeType
        ? `${fee.feeType}${fee.feeMonth ? ` (${fee.feeMonth})` : ""}`
        : "Fee";
      allEvents.push({
        id: `fee-payment-${fee.id}`,
        eventType: HistoryEventType.FEE_PAYMENT,
        date: fee.paymentDate,
        title: fee.isVoid
          ? `Fee Payment Voided — ${feeLabel}`
          : `Fee Paid — ${feeLabel}`,
        description: `${amt} via ${fee.paymentMethod}. Receipt: ${
          fee.receiptNumber
        }${fee.isVoid ? " [VOIDED]" : ""}`,
        metadata: {
          amountPaid: fee.amountPaid,
          paymentMethod: fee.paymentMethod,
          receiptNumber: fee.receiptNumber,
          feeType: fee.feeType,
          feeMonth: fee.feeMonth,
          isVoid: fee.isVoid,
          notes: fee.notes,
          recordedBy: fee.recordedByName,
        },
        academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
        classSection: ctx
          ? { className: ctx.className, sectionName: ctx.sectionName }
          : null,
      });
    }
  }

  // Fee concession events
  if (
    enrollmentIds.length > 0 &&
    shouldInclude(HistoryEventType.FEE_CONCESSION)
  ) {
    const concRows = await db
      .select({
        id: schoolFeeConcessionsSchema.id,
        enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
        concessionType: schoolFeeConcessionsSchema.concessionType,
        concessionValue: schoolFeeConcessionsSchema.concessionValue,
        reason: schoolFeeConcessionsSchema.reason,
        isActive: schoolFeeConcessionsSchema.isActive,
        createdAt: schoolFeeConcessionsSchema.createdAt,
        revokedAt: schoolFeeConcessionsSchema.revokedAt,
        feeType: schoolFeeStructuresSchema.feeType,
        approvedByName: schoolUsersSchema.name,
      })
      .from(schoolFeeConcessionsSchema)
      .leftJoin(
        schoolFeeStructuresSchema,
        eq(
          schoolFeeConcessionsSchema.feeStructureId,
          schoolFeeStructuresSchema.id
        )
      )
      .leftJoin(
        schoolUsersSchema,
        eq(schoolFeeConcessionsSchema.approvedBy, schoolUsersSchema.id)
      )
      .where(inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds))
      .orderBy(desc(schoolFeeConcessionsSchema.createdAt))
      .all();

    const enrollmentCtx = new Map(
      enrollmentRows.map((e) => [
        e.id,
        {
          className: e.className,
          sectionName: e.sectionName,
          yearId: e.academicYearId,
          yearName: e.yearName,
        },
      ])
    );

    for (const con of concRows) {
      const ctx = enrollmentCtx.get(con.enrollmentId);
      const val =
        con.concessionType === "PERCENTAGE"
          ? `${con.concessionValue}% off`
          : `₹${(con.concessionValue / 100).toLocaleString("en-IN")} off`;
      allEvents.push({
        id: `fee-concession-${con.id}`,
        eventType: HistoryEventType.FEE_CONCESSION,
        date: con.createdAt.split("T")[0],
        title: con.isActive
          ? `Fee Concession Granted — ${con.feeType ?? "Fee"}`
          : `Fee Concession Revoked — ${con.feeType ?? "Fee"}`,
        description: `${val}. Reason: ${con.reason}`,
        metadata: {
          concessionType: con.concessionType,
          concessionValue: con.concessionValue,
          reason: con.reason,
          isActive: con.isActive,
          revokedAt: con.revokedAt,
          approvedBy: con.approvedByName,
        },
        academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
        classSection: ctx
          ? { className: ctx.className, sectionName: ctx.sectionName }
          : null,
      });
    }
  }

  // Exam marks events
  if (enrollmentIds.length > 0 && shouldInclude(HistoryEventType.EXAM_MARKS)) {
    const markRows = await db
      .select({
        id: schoolExamMarksSchema.id,
        enrollmentId: schoolExamMarksSchema.enrollmentId,
        marksObtained: schoolExamMarksSchema.marksObtained,
        grade: schoolExamMarksSchema.grade,
        remarks: schoolExamMarksSchema.remarks,
        createdAt: schoolExamMarksSchema.createdAt,
        examName: schoolExamsSchema.name,
        examType: schoolExamsSchema.type,
        subjectName: schoolSubjectsSchema.name,
        enteredByName: schoolUsersSchema.name,
      })
      .from(schoolExamMarksSchema)
      .innerJoin(
        schoolExamsSchema,
        eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
      )
      .innerJoin(
        schoolClassSectionSubjectsSchema,
        eq(
          schoolExamMarksSchema.classSubjectId,
          schoolClassSectionSubjectsSchema.id
        )
      )
      .innerJoin(
        schoolSubjectsSchema,
        eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
      )
      .leftJoin(
        schoolUsersSchema,
        eq(schoolExamMarksSchema.enteredBy, schoolUsersSchema.id)
      )
      .where(inArray(schoolExamMarksSchema.enrollmentId, enrollmentIds))
      .orderBy(desc(schoolExamMarksSchema.createdAt))
      .all();

    const enrollmentCtx = new Map(
      enrollmentRows.map((e) => [
        e.id,
        {
          className: e.className,
          sectionName: e.sectionName,
          yearId: e.academicYearId,
          yearName: e.yearName,
        },
      ])
    );

    for (const mark of markRows) {
      const ctx = enrollmentCtx.get(mark.enrollmentId);
      allEvents.push({
        id: `exam-mark-${mark.id}`,
        eventType: HistoryEventType.EXAM_MARKS,
        date: mark.createdAt.split("T")[0],
        title: `Marks Entered — ${mark.examName} / ${mark.subjectName}`,
        description: `${mark.subjectName}: ${mark.marksObtained} marks${
          mark.grade ? ` (Grade: ${mark.grade})` : ""
        }${mark.remarks ? `. ${mark.remarks}` : ""}`,
        metadata: {
          examName: mark.examName,
          examType: mark.examType,
          subjectName: mark.subjectName,
          marksObtained: mark.marksObtained,
          grade: mark.grade,
          remarks: mark.remarks,
          enteredBy: mark.enteredByName,
        },
        academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
        classSection: ctx
          ? { className: ctx.className, sectionName: ctx.sectionName }
          : null,
      });
    }
  }

  // Assignment submission / graded events
  if (
    enrollmentIds.length > 0 &&
    (shouldInclude(HistoryEventType.ASSIGNMENT_SUBMISSION) ||
      shouldInclude(HistoryEventType.ASSIGNMENT_GRADED))
  ) {
    const subConditions: any[] = [
      inArray(schoolAssignmentSubmissionsSchema.enrollmentId, enrollmentIds),
    ];
    if (dateFrom)
      subConditions.push(
        gte(schoolAssignmentSubmissionsSchema.updatedAt, dateFrom)
      );
    if (dateTo)
      subConditions.push(
        lte(schoolAssignmentSubmissionsSchema.updatedAt, dateTo)
      );

    const subRows = await db
      .select({
        id: schoolAssignmentSubmissionsSchema.id,
        enrollmentId: schoolAssignmentSubmissionsSchema.enrollmentId,
        studentStatus: schoolAssignmentSubmissionsSchema.studentStatus,
        teacherStatus: schoolAssignmentSubmissionsSchema.teacherStatus,
        marksObtained: schoolAssignmentSubmissionsSchema.marksObtained,
        remarks: schoolAssignmentSubmissionsSchema.remarks,
        updatedAt: schoolAssignmentSubmissionsSchema.updatedAt,
        assignmentTitle: schoolAssignmentsSchema.title,
        assignmentType: schoolAssignmentsSchema.type,
        maxMarks: schoolAssignmentsSchema.maxMarks,
        dueDate: schoolAssignmentsSchema.dueDate,
      })
      .from(schoolAssignmentSubmissionsSchema)
      .innerJoin(
        schoolAssignmentsSchema,
        eq(
          schoolAssignmentSubmissionsSchema.assignmentId,
          schoolAssignmentsSchema.id
        )
      )
      .where(and(...subConditions))
      .orderBy(desc(schoolAssignmentSubmissionsSchema.updatedAt))
      .all();

    const enrollmentCtx = new Map(
      enrollmentRows.map((e) => [
        e.id,
        {
          className: e.className,
          sectionName: e.sectionName,
          yearId: e.academicYearId,
          yearName: e.yearName,
        },
      ])
    );

    for (const sub of subRows) {
      const ctx = enrollmentCtx.get(sub.enrollmentId);
      if (
        sub.studentStatus === "MARKED_AS_DONE" &&
        shouldInclude(HistoryEventType.ASSIGNMENT_SUBMISSION)
      ) {
        allEvents.push({
          id: `assignment-sub-${sub.id}`,
          eventType: HistoryEventType.ASSIGNMENT_SUBMISSION,
          date: sub.updatedAt.split("T")[0],
          title: `Assignment Submitted — ${sub.assignmentTitle}`,
          description: `Student marked "${sub.assignmentTitle}" (${sub.assignmentType}) as done`,
          metadata: {
            assignmentTitle: sub.assignmentTitle,
            assignmentType: sub.assignmentType,
            dueDate: sub.dueDate,
            studentStatus: sub.studentStatus,
            teacherStatus: sub.teacherStatus,
          },
          academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
          classSection: ctx
            ? { className: ctx.className, sectionName: ctx.sectionName }
            : null,
        });
      }
      if (
        sub.teacherStatus === "GRADED" &&
        shouldInclude(HistoryEventType.ASSIGNMENT_GRADED)
      ) {
        allEvents.push({
          id: `assignment-graded-${sub.id}`,
          eventType: HistoryEventType.ASSIGNMENT_GRADED,
          date: sub.updatedAt.split("T")[0],
          title: `Assignment Graded — ${sub.assignmentTitle}`,
          description:
            sub.marksObtained != null && sub.maxMarks
              ? `Scored ${sub.marksObtained}/${sub.maxMarks}${
                  sub.remarks ? `. Remarks: ${sub.remarks}` : ""
                }`
              : `Graded${sub.remarks ? `. Remarks: ${sub.remarks}` : ""}`,
          metadata: {
            assignmentTitle: sub.assignmentTitle,
            assignmentType: sub.assignmentType,
            marksObtained: sub.marksObtained,
            maxMarks: sub.maxMarks,
            remarks: sub.remarks,
          },
          academicYear: ctx ? { id: ctx.yearId, name: ctx.yearName } : null,
          classSection: ctx
            ? { className: ctx.className, sectionName: ctx.sectionName }
            : null,
        });
      }
    }
  }

  // ── Sort + date filter + paginate ─────────────────────────────────────────
  allEvents.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const filtered = allEvents.filter((e) => {
    const d = e.date.substring(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  });

  const totalEvents = filtered.length;
  const totalPages = Math.ceil(totalEvents / limit);
  const offset = (page - 1) * limit;

  return {
    student: {
      id: studentRow.id,
      name: studentRow.name,
      email: studentRow.email,
      username: studentRow.username,
      primaryRole: studentRow.primaryRole,
      avatarUrl: studentRow.avatarUrl || null,
      admissionNumber: studentRow.admissionNumber || null,
      rollNumber: studentRow.rollNumber || null,
      admissionDate: studentRow.admissionDate || null,
      gender: studentRow.gender || null,
      dateOfBirth: studentRow.dateOfBirth || null,
      fatherName: studentRow.fatherName || null,
      motherName: studentRow.motherName || null,
      guardianName: studentRow.guardianName || null,
      phone: studentRow.phone || null,
      isActive: studentRow.isActive,
      createdAt: studentRow.createdAt,
    },
    isDeparted,
    enrollments,
    attendanceSummaries,
    academicPerformance,
    feeSummaries,
    events: filtered.slice(offset, offset + limit),
    pagination: { page, limit, totalEvents, totalPages },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function buildAttendanceSummaries(
  db: any,
  enrollmentRows: any[],
  enrollmentIds: number[]
): Promise<AttendanceSummary[]> {
  if (enrollmentIds.length === 0) return [];

  const rawRows = (await db
    .select({
      enrollmentId: schoolAttendancesSchema.enrollmentId,
      status: schoolAttendancesSchema.status,
      cnt: sql<number>`count(*)`,
    })
    .from(schoolAttendancesSchema)
    .where(inArray(schoolAttendancesSchema.enrollmentId, enrollmentIds))
    .groupBy(
      schoolAttendancesSchema.enrollmentId,
      schoolAttendancesSchema.status
    )
    .all()) as { enrollmentId: number; status: string; cnt: number }[];

  const byEnrollment = new Map<number, typeof rawRows>();
  for (const row of rawRows) {
    if (!byEnrollment.has(row.enrollmentId))
      byEnrollment.set(row.enrollmentId, []);
    byEnrollment.get(row.enrollmentId)!.push(row);
  }

  return enrollmentRows.map((enr) => {
    const rows = byEnrollment.get(enr.id) ?? [];
    let workingDays = 0,
      present = 0,
      absent = 0,
      late = 0,
      halfDay = 0,
      excused = 0;
    for (const row of rows) {
      const s = row.status,
        n = row.cnt;
      if (NEUTRAL_STATUSES.includes(s as any)) {
        if (s === "EXCUSED") excused += n;
        continue;
      }
      workingDays += n;
      if (s === "PRESENT") present += n;
      else if (s === "LATE") {
        present += n;
        late += n;
      } else if (s === "HALF_DAY") {
        present += n * 0.5;
        halfDay += n;
      } else if (ABSENT_EQUIVALENT_STATUSES.includes(s as any)) absent += n;
    }
    return {
      academicYearId: enr.academicYearId,
      academicYearName: enr.yearName,
      className: enr.className,
      sectionName: enr.sectionName,
      totalWorkingDays: workingDays,
      presentDays: present,
      absentDays: absent,
      lateDays: late,
      halfDays: halfDay,
      excusedDays: excused,
      attendancePercentage:
        workingDays > 0
          ? Math.round((present / workingDays) * 100 * 10) / 10
          : 0,
    };
  });
}

async function buildAcademicPerformance(
  db: any,
  enrollmentRows: any[],
  enrollmentIds: number[]
): Promise<AcademicPerformanceSummary[]> {
  if (enrollmentIds.length === 0) return [];

  const markRows = await db
    .select({
      enrollmentId: schoolExamMarksSchema.enrollmentId,
      examId: schoolExamMarksSchema.examId,
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      examName: schoolExamsSchema.name,
      examType: schoolExamsSchema.type,
      subjectName: schoolSubjectsSchema.name,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamsSchema,
      eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamMarksSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(inArray(schoolExamMarksSchema.enrollmentId, enrollmentIds))
    .all();

  const enrollmentCtx = new Map(enrollmentRows.map((e) => [e.id, e]));
  const grouped = new Map<
    number,
    Map<number, { examName: string; examType: string; subjects: any[] }>
  >();

  for (const row of markRows) {
    if (!grouped.has(row.enrollmentId))
      grouped.set(row.enrollmentId, new Map());
    const examMap = grouped.get(row.enrollmentId)!;
    if (!examMap.has(row.examId))
      examMap.set(row.examId, {
        examName: row.examName,
        examType: row.examType,
        subjects: [],
      });
    examMap
      .get(row.examId)!
      .subjects.push({
        subjectName: row.subjectName,
        marksObtained: row.marksObtained,
        maxMarks: 100,
        grade: row.grade,
      });
  }

  const result: AcademicPerformanceSummary[] = [];
  for (const [enrollmentId, examMap] of grouped.entries()) {
    const ctx = enrollmentCtx.get(enrollmentId);
    if (!ctx) continue;
    const exams = [];
    for (const [examId, examData] of examMap.entries()) {
      const totalMarks = examData.subjects.reduce(
        (s: number, r: any) => s + r.marksObtained,
        0
      );
      const totalMax = examData.subjects.reduce(
        (s: number, r: any) => s + r.maxMarks,
        0
      );
      exams.push({
        examId,
        examName: examData.examName,
        examType: examData.examType,
        subjectResults: examData.subjects,
        totalMarks,
        totalMaxMarks: totalMax,
        percentage:
          totalMax > 0
            ? Math.round((totalMarks / totalMax) * 100 * 10) / 10
            : 0,
      });
    }
    result.push({
      academicYearId: ctx.academicYearId,
      academicYearName: ctx.yearName,
      className: ctx.className,
      sectionName: ctx.sectionName,
      exams,
    });
  }
  return result;
}

async function buildFeeSummaries(
  db: any,
  enrollmentRows: any[],
  enrollmentIds: number[]
): Promise<FeeSummary[]> {
  if (enrollmentIds.length === 0) return [];

  const chargedRows = (await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      totalCharged: sql<number>`coalesce(sum(${schoolFeeStructuresSchema.amount}), 0)`,
    })
    .from(schoolStudentEnrollmentsSchema)
    .leftJoin(
      schoolFeeStructuresSchema,
      and(
        eq(
          schoolFeeStructuresSchema.classSectionId,
          schoolStudentEnrollmentsSchema.classSectionId
        ),
        eq(
          schoolFeeStructuresSchema.academicYearId,
          schoolStudentEnrollmentsSchema.academicYearId
        )
      )
    )
    .where(inArray(schoolStudentEnrollmentsSchema.id, enrollmentIds))
    .groupBy(schoolStudentEnrollmentsSchema.id)
    .all()) as { enrollmentId: number; totalCharged: number }[];

  const paidRows = (await db
    .select({
      enrollmentId: schoolFeePaymentsSchema.enrollmentId,
      totalPaid: sql<number>`coalesce(sum(${schoolFeePaymentsSchema.amountPaid}), 0)`,
      paymentCount: sql<number>`count(*)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds),
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(schoolFeePaymentsSchema.enrollmentId)
    .all()) as {
    enrollmentId: number;
    totalPaid: number;
    paymentCount: number;
  }[];

  const concRows = (await db
    .select({
      enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
      totalConcession: sql<number>`coalesce(sum(CASE WHEN ${schoolFeeConcessionsSchema.concessionType} = 'FIXED' THEN ${schoolFeeConcessionsSchema.concessionValue} ELSE 0 END), 0)`,
    })
    .from(schoolFeeConcessionsSchema)
    .where(
      and(
        inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds),
        eq(schoolFeeConcessionsSchema.isActive, true)
      )
    )
    .groupBy(schoolFeeConcessionsSchema.enrollmentId)
    .all()) as { enrollmentId: number; totalConcession: number }[];

  const chargedMap = new Map(
    chargedRows.map((r) => [r.enrollmentId, r.totalCharged])
  );
  const paidMap = new Map(paidRows.map((r) => [r.enrollmentId, r]));
  const concMap = new Map(
    concRows.map((r) => [r.enrollmentId, r.totalConcession])
  );

  return enrollmentRows.map((enr) => {
    const charged = chargedMap.get(enr.id) ?? 0;
    const paid = paidMap.get(enr.id) ?? { totalPaid: 0, paymentCount: 0 };
    const concession = concMap.get(enr.id) ?? 0;
    const balance = Math.max(0, charged - concession - paid.totalPaid);
    return {
      academicYearId: enr.academicYearId,
      academicYearName: enr.yearName,
      totalCharged: charged,
      totalPaid: paid.totalPaid,
      totalConcession: concession,
      balance,
      paymentCount: paid.paymentCount,
    };
  });
}
