// src/modules/school/dashboard/services.ts
// Production-grade, persona-aware dashboard service

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import {
  schoolAcademicYearsSchema,
  schoolAssignmentSubmissionsSchema,
  schoolAttendancesSchema,
  schoolClassesSchema,
  schoolClassSectionSubjectsSchema,
  schoolClassSectionsSchema,
  schoolExamMarksSchema,
  schoolExamsSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolNotificationsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolSubjectsSchema,
  schoolTeacherAssignmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
  studentsSchema,
  schoolFeeConcessionsSchema,
  schoolStudentFeeAssignmentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DashboardPersona =
  | "OWNER"
  | "MANAGEMENT"
  | "TEACHER"
  | "STUDENT"
  | "PARENT"
  | "GENERAL_STAFF";

export interface DashboardNotification {
  id: number;
  title: string;
  message: string;
  createdAt: string;
}

export interface DashboardAssignedClass {
  className: string;
  sectionName: string;
  subjectName: string;
  classSectionId: number;
  teacherAssignmentId: number;
  isPrimary: boolean;
}

export interface DashboardGrade {
  examName: string;
  marksObtained: number;
  grade?: string;
  remarks?: string;
}

// ── NEW: Attendance coverage item (one row per active class-section) ──────────
// Returned only for OWNER and MANAGEMENT personas.
// Built with a single LEFT JOIN query — no N+1.
export interface AttendanceCoverageItem {
  classSectionId: number;
  className: string;
  sectionName: string;
  /** True when at least one attendance record exists for today's date. */
  isMarked: boolean;
  /** Number of student attendance records entered today for this section. */
  markedCount: number;
  /** Total active enrollments in this section (for "X / Y students" display). */
  totalEnrolled: number;
}

export interface DashboardStats {
  // Owner / Management
  totalStudents?: number;
  totalTeachers?: number;
  totalStaff?: number;
  currentEnrollments?: number;
  // NOTE: feesCollected / feesPending / feeCollectionRate are intentionally
  // OMITTED from the OWNER persona response — the owner has a dedicated fee
  // dashboard at /school/fees/dashboard. Keeping them out here prevents
  // duplication and avoids confusion.
  activeClassSections?: number;

  // ── OWNER / MANAGEMENT: Attendance summary chips ──────────────────────────
  // Rendered as a single "8 / 12 Sections" stat card above the coverage list.
  sectionsMarkedToday?: number;
  totalActiveSections?: number;

  // Teacher
  attendancesMarkedToday?: number;
  pendingSubmissions?: number;

  // Student / Parent
  myClass?: string;
  mySection?: string;
  rollNumber?: string;
  attendancePercentage?: number;
  totalDaysTracked?: number;
  pendingAssignments?: number;

  // PARENT — child identity fields
  childName?: string;
  childAvatarUrl?: string;
  childGender?: string;
  childBloodGroup?: string;
  childAdmissionDate?: string;
  childMedicalInfo?: string;

  // PARENT — attendance breakdown
  presentDays?: number;
  absentDays?: number;

  // PARENT — fees
  totalFeeDue?: number;

  [key: string]: number | string | undefined;
}

export interface DashboardLists {
  recentNotifications?: DashboardNotification[];
  assignedClasses?: DashboardAssignedClass[];
  recentGrades?: DashboardGrade[];
  // ── NEW: per-section attendance coverage (OWNER / MANAGEMENT only) ─────────
  attendanceCoverage?: AttendanceCoverageItem[];
  [key: string]: any[] | undefined;
}

export interface DashboardData {
  persona: DashboardPersona;
  stats: DashboardStats;
  lists: DashboardLists;
}

// ─── Role → Persona mapping ───────────────────────────────────────────────────

function resolvePersona(role: string): DashboardPersona {
  switch (role) {
    case SchoolRole.SCHOOL_OWNER:
      return "OWNER";
    case SchoolRole.PRINCIPAL:
    case SchoolRole.MANAGER:
    case SchoolRole.ADMISSION_OFFICER:
    case SchoolRole.ACCOUNTANT:
      return "MANAGEMENT";
    case SchoolRole.TEACHER:
      return "TEACHER";
    case SchoolRole.STUDENT:
      return "STUDENT";
    case SchoolRole.STUDENT_PARENT:
      return "PARENT";
    default:
      return "GENERAL_STAFF";
  }
}

// ─── Main dashboard data loader ───────────────────────────────────────────────

export async function getDashboardData(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  role: string,
  activeChildId: number | null
): Promise<DashboardData> {
  const db = await getSchoolDB(env, schoolCode);
  const persona = resolvePersona(role);

  switch (persona) {
    case "OWNER":
    case "MANAGEMENT":
      return buildOwnerManagementDashboard(db, persona);
    case "TEACHER":
      return buildTeacherDashboard(db, userId);
    case "STUDENT":
      return buildStudentDashboard(db, userId);
    case "PARENT":
      return buildParentDashboard(db, userId, activeChildId);
    default:
      return buildGeneralStaffDashboard(db);
  }
}

// ─── Shared helper ────────────────────────────────────────────────────────────

async function fetchRecentNotifications(
  db: any
): Promise<DashboardNotification[]> {
  return db
    .select({
      id: schoolNotificationsSchema.id,
      title: schoolNotificationsSchema.title,
      message: schoolNotificationsSchema.message,
      createdAt: schoolNotificationsSchema.createdAt,
    })
    .from(schoolNotificationsSchema)
    .orderBy(desc(schoolNotificationsSchema.createdAt))
    .limit(5)
    .all();
}

// ─── NEW: Attendance coverage fetcher ────────────────────────────────────────
// Single round-trip query:
//   1. All active class-sections (LEFT JOIN to get name parts)
//   2. LEFT JOIN active enrollments → count totalEnrolled
//   3. LEFT JOIN today's attendances → count markedCount
// One GROUP BY gives us everything in a single pass.
//
// "isMarked" = markedCount > 0 (at least one student's attendance recorded).
// This is intentional — a teacher who marks even one student has "started";
// the markedCount / totalEnrolled ratio tells the owner how complete it is.

async function fetchAttendanceCoverage(
  db: any,
  today: string // "YYYY-MM-DD"
): Promise<AttendanceCoverageItem[]> {
  // We use raw SQL via Drizzle's sql`` template for the conditional COUNT
  // because Drizzle ORM doesn't expose CASE WHEN inside aggregate directly.
  const rows: Array<{
    classSectionId: number;
    className: string;
    sectionName: string;
    classSortOrder: number;
    totalEnrolled: number;
    markedCount: number;
  }> = await db
    .select({
      classSectionId: schoolClassSectionsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      classSortOrder: schoolClassesSchema.sort_order,
      // Total active students enrolled in this section
      totalEnrolled: sql<number>`
        COUNT(DISTINCT ${schoolStudentEnrollmentsSchema.id})
      `,
      // Attendance records entered for THIS section on today's date
      markedCount: sql<number>`
        COUNT(DISTINCT CASE
          WHEN ${schoolAttendancesSchema.date} = ${today}
          THEN ${schoolAttendancesSchema.id}
          ELSE NULL
        END)
      `,
    })
    .from(schoolClassSectionsSchema)
    // Join class name
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    // Join section name
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    // LEFT JOIN enrollments so sections with 0 students still appear
    .leftJoin(
      schoolStudentEnrollmentsSchema,
      and(
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          schoolClassSectionsSchema.id
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    // LEFT JOIN attendances for today only (scoped via CASE WHEN above)
    .leftJoin(
      schoolAttendancesSchema,
      eq(
        schoolAttendancesSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    // Only active sections
    .where(eq(schoolClassSectionsSchema.isActive, true))
    // One row per class-section
    .groupBy(
      schoolClassSectionsSchema.id,
      schoolClassesSchema.name,
      schoolSectionsSchema.name,
      schoolClassesSchema.sort_order 
    )
    // Pending sections first (isMarked = false), then by class name
    .orderBy(
      sql`COUNT(DISTINCT CASE WHEN ${schoolAttendancesSchema.date} = ${today} THEN ${schoolAttendancesSchema.id} ELSE NULL END) = 0 DESC`,
      schoolClassesSchema.sort_order,
      schoolSectionsSchema.name
    )
    .all();

  return rows.map((row) => ({
    classSectionId: row.classSectionId,
    className: row.className,
    sectionName: row.sectionName,
    isMarked: row.markedCount > 0,
    markedCount: row.markedCount,
    totalEnrolled: row.totalEnrolled,
  }));
}

// ─── OWNER / MANAGEMENT ───────────────────────────────────────────────────────

async function buildOwnerManagementDashboard(
  db: any,
  persona: DashboardPersona
): Promise<DashboardData> {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  // ── Core counts ─────────────────────────────────────────────────────────
  const totalStudents =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(studentsSchema)
        .get()
    )?.count ?? 0;

  const totalTeachers =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolTeacherAssignmentsSchema)
        .get()
    )?.count ?? 0;

  const currentEnrollments = currentYear
    ? (
        await db
          .select({ count: sql<number>`count(*)` })
          .from(schoolStudentEnrollmentsSchema)
          .where(
            and(
              eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
              eq(schoolStudentEnrollmentsSchema.isActive, true)
            )
          )
          .get()
      )?.count ?? 0
    : 0;

  const activeClassSections =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolClassSectionsSchema)
        .where(eq(schoolClassSectionsSchema.isActive, true))
        .get()
    )?.count ?? 0;

  // ── Attendance coverage (single query — see fetchAttendanceCoverage) ──────
  const attendanceCoverage = await fetchAttendanceCoverage(db, today);

  const sectionsMarkedToday = attendanceCoverage.filter(
    (s) => s.isMarked
  ).length;
  const totalActiveSections = attendanceCoverage.length;

  // ── Notifications ─────────────────────────────────────────────────────────
  const recentNotifications = await fetchRecentNotifications(db);

  // NOTE: feesCollected / feesPending / feeCollectionRate intentionally
  // excluded — owner has a dedicated /school/fees/dashboard for those.

  return {
    persona,
    stats: {
      totalStudents,
      totalTeachers,
      currentEnrollments,
      activeClassSections,
      sectionsMarkedToday,
      totalActiveSections,
    },
    lists: {
      recentNotifications,
      attendanceCoverage,
    },
  };
}

// ─── TEACHER ──────────────────────────────────────────────────────────────────

async function buildTeacherDashboard(
  db: any,
  userId: number
): Promise<DashboardData> {
  const assignedClasses: DashboardAssignedClass[] = await db
    .select({
      teacherAssignmentId: schoolTeacherAssignmentsSchema.id,
      classSectionId: schoolClassSectionSubjectsSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      subjectName: schoolSubjectsSchema.name,
      isPrimary: schoolTeacherAssignmentsSchema.isPrimary,
    })
    .from(schoolTeacherAssignmentsSchema)
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionSubjectsSchema.classSectionId,
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
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(eq(schoolTeacherAssignmentsSchema.teacherId, userId))
    .all();

  const today = new Date().toISOString().slice(0, 10);
  const attendancesMarkedToday =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAttendancesSchema)
        .where(
          and(
            eq(schoolAttendancesSchema.markedBy, userId),
            eq(schoolAttendancesSchema.date, today)
          )
        )
        .get()
    )?.count ?? 0;

  const pendingSubmissions =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAssignmentSubmissionsSchema)
        .where(eq(schoolAssignmentSubmissionsSchema.teacherStatus, "RECEIVED"))
        .get()
    )?.count ?? 0;

  const recentNotifications = await fetchRecentNotifications(db);

  return {
    persona: "TEACHER",
    stats: { attendancesMarkedToday, pendingSubmissions },
    lists: { assignedClasses, recentNotifications },
  };
}

// ─── STUDENT ──────────────────────────────────────────────────────────────────

async function buildStudentDashboard(
  db: any,
  userId: number
): Promise<DashboardData> {
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) {
    return {
      persona: "STUDENT",
      stats: {},
      lists: { recentNotifications: [] },
    };
  }

  const enrollment = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
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
        eq(schoolStudentEnrollmentsSchema.studentId, userId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) {
    return {
      persona: "STUDENT",
      stats: {},
      lists: { recentNotifications: [] },
    };
  }

  const totalDays =
    (
      await db
        .select({
          count: sql<number>`count(distinct ${schoolAttendancesSchema.date})`,
        })
        .from(schoolAttendancesSchema)
        .where(
          eq(schoolAttendancesSchema.enrollmentId, enrollment.enrollmentId)
        )
        .get()
    )?.count ?? 0;

  const presentDays =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAttendancesSchema)
        .where(
          and(
            eq(schoolAttendancesSchema.enrollmentId, enrollment.enrollmentId),
            eq(schoolAttendancesSchema.status, "PRESENT")
          )
        )
        .get()
    )?.count ?? 0;

  const attendancePercentage =
    totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

  const pendingAssignments =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAssignmentSubmissionsSchema)
        .where(
          and(
            eq(
              schoolAssignmentSubmissionsSchema.enrollmentId,
              enrollment.enrollmentId
            ),
            eq(schoolAssignmentSubmissionsSchema.studentStatus, "PENDING")
          )
        )
        .get()
    )?.count ?? 0;

  const recentGrades: DashboardGrade[] = await db
    .select({
      examName: schoolExamsSchema.name,
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      remarks: schoolExamMarksSchema.remarks,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamsSchema,
      eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
    )
    .where(eq(schoolExamMarksSchema.enrollmentId, enrollment.enrollmentId))
    .orderBy(desc(schoolExamsSchema.createdAt))
    .limit(5)
    .all();

  const recentNotifications = await fetchRecentNotifications(db);

  return {
    persona: "STUDENT",
    stats: {
      myClass: enrollment.className,
      mySection: enrollment.sectionName,
      rollNumber: enrollment.rollNumber ?? undefined,
      attendancePercentage,
      totalDaysTracked: totalDays,
      pendingAssignments,
    },
    lists: { recentGrades, recentNotifications },
  };
}

// ─── PARENT ───────────────────────────────────────────────────────────────────

async function buildParentDashboard(
  db: any,
  parentUserId: number,
  activeChildId: number | null
): Promise<DashboardData> {
  if (!activeChildId) {
    const recentNotifications = await fetchRecentNotifications(db);
    return {
      persona: "PARENT",
      stats: {},
      lists: { recentNotifications },
    };
  }

  // Security: verify parent↔child link
  const link = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.parentId, parentUserId),
        eq(studentParentsSchema.studentId, activeChildId)
      )
    )
    .get();

  if (!link) {
    console.warn(
      `[Dashboard/Parent] User ${parentUserId} attempted to access child ${activeChildId} — not linked`
    );
    const recentNotifications = await fetchRecentNotifications(db);
    return {
      persona: "PARENT",
      stats: {},
      lists: { recentNotifications },
    };
  }

  const childUser = await db
    .select({
      name: schoolUsersSchema.name,
      avatarUrl: schoolUsersSchema.avatarUrl,
      gender: schoolUsersSchema.gender,
      bloodGroup: schoolUsersSchema.bloodGroup,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, activeChildId))
    .get();

  const studentProfile = await db
    .select({
      admissionDate: studentsSchema.admissionDate,
      previousSchool: studentsSchema.previousSchool,
      medicalInfo: studentsSchema.medicalInfo,
    })
    .from(studentsSchema)
    .where(eq(studentsSchema.userId, activeChildId))
    .get();

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  const recentNotifications = await fetchRecentNotifications(db);

  const baseStats: DashboardStats = {
    childName: childUser?.name ?? undefined,
    childAvatarUrl: childUser?.avatarUrl || undefined,
    childGender: childUser?.gender || undefined,
    childBloodGroup: childUser?.bloodGroup || undefined,
    childAdmissionDate: studentProfile?.admissionDate || undefined,
  };

  if (!currentYear) {
    return {
      persona: "PARENT",
      stats: baseStats,
      lists: { recentNotifications },
    };
  }

  const enrollment = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
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
        eq(schoolStudentEnrollmentsSchema.studentId, activeChildId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) {
    return {
      persona: "PARENT",
      stats: baseStats,
      lists: { recentNotifications },
    };
  }

  const totalDays =
    (
      await db
        .select({
          count: sql<number>`count(distinct ${schoolAttendancesSchema.date})`,
        })
        .from(schoolAttendancesSchema)
        .where(
          eq(schoolAttendancesSchema.enrollmentId, enrollment.enrollmentId)
        )
        .get()
    )?.count ?? 0;

  const presentDays =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAttendancesSchema)
        .where(
          and(
            eq(schoolAttendancesSchema.enrollmentId, enrollment.enrollmentId),
            eq(schoolAttendancesSchema.status, "PRESENT")
          )
        )
        .get()
    )?.count ?? 0;

  const absentDays = totalDays - presentDays;
  const attendancePercentage =
    totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

  // ── Fees: structure fees + custom assignments, both concession-aware ────
  // Step 1: Standard fee structures for this class-section
  const feeStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, enrollment.classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, currentYear.id)
      )
    )
    .all();

  // Step 2: Structure-level concessions for this enrollment
  const structureConcessions =
    feeStructures.length > 0
      ? await db
          .select({
            feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              eq(
                schoolFeeConcessionsSchema.enrollmentId,
                enrollment.enrollmentId
              ),
              eq(schoolFeeConcessionsSchema.isActive, true),
              sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`
            )
          )
          .all()
      : [];

  const structureConcessionMap = new Map<number, any>(
    structureConcessions.map((c: any) => [c.feeStructureId, c])
  );

  let totalStructureOriginal = 0;
  let totalStructureConcession = 0;

  for (const fee of feeStructures) {
    totalStructureOriginal += fee.amount;
    const conc = structureConcessionMap.get(fee.id);
    if (conc) {
      const d =
        conc.concessionType === "FIXED"
          ? conc.concessionValue
          : Math.floor((fee.amount * conc.concessionValue) / 100);
      totalStructureConcession += Math.min(d, fee.amount);
    }
  }

  // Step 3: Custom fee assignments for this enrollment
  const assignments = await db
    .select({
      id: schoolStudentFeeAssignmentsSchema.id,
      amount: schoolStudentFeeAssignmentsSchema.amount,
    })
    .from(schoolStudentFeeAssignmentsSchema)
    .where(
      and(
        eq(
          schoolStudentFeeAssignmentsSchema.enrollmentId,
          enrollment.enrollmentId
        ),
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
      )
    )
    .all();

  // Step 4: Assignment-level concessions for this enrollment
  const assignmentConcessions =
    assignments.length > 0
      ? await db
          .select({
            studentFeeAssignmentId:
              schoolFeeConcessionsSchema.studentFeeAssignmentId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              eq(
                schoolFeeConcessionsSchema.enrollmentId,
                enrollment.enrollmentId
              ),
              eq(schoolFeeConcessionsSchema.isActive, true),
              sql`${schoolFeeConcessionsSchema.studentFeeAssignmentId} IS NOT NULL`
            )
          )
          .all()
      : [];

  const assignmentConcessionMap = new Map<number, any>(
    assignmentConcessions.map((c: any) => [c.studentFeeAssignmentId, c])
  );

  let totalAssignmentOriginal = 0;
  let totalAssignmentConcession = 0;

  for (const a of assignments) {
    totalAssignmentOriginal += a.amount;
    const conc = assignmentConcessionMap.get(a.id);
    if (conc) {
      const d =
        conc.concessionType === "FIXED"
          ? conc.concessionValue
          : Math.floor((a.amount * conc.concessionValue) / 100);
      totalAssignmentConcession += Math.min(d, a.amount);
    }
  }

  // Step 5: Payments — structure fees (void-filtered)
  const structureFeeIds = feeStructures.map((f: any) => f.id);
  const structurePaidResult =
    structureFeeIds.length > 0
      ? await db
          .select({
            total: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              eq(schoolFeePaymentsSchema.enrollmentId, enrollment.enrollmentId),
              inArray(schoolFeePaymentsSchema.feeStructureId, structureFeeIds),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .get()
      : { total: 0 };

  // Step 6: Payments — custom assignments (void-filtered)
  const assignmentIds = assignments.map((a: any) => a.id);
  const assignmentPaidResult =
    assignmentIds.length > 0
      ? await db
          .select({
            total: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              eq(schoolFeePaymentsSchema.enrollmentId, enrollment.enrollmentId),
              inArray(
                schoolFeePaymentsSchema.studentFeeAssignmentId,
                assignmentIds
              ),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .get()
      : { total: 0 };

  // Step 7: Aggregate — all in paise
  const totalOriginal = totalStructureOriginal + totalAssignmentOriginal;
  const totalConcession = totalStructureConcession + totalAssignmentConcession;
  const totalDue = totalOriginal - totalConcession;
  const totalPaid =
    (structurePaidResult?.total ?? 0) + (assignmentPaidResult?.total ?? 0);
  const feesPending = Math.max(0, totalDue - totalPaid);

  const pendingAssignments =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolAssignmentSubmissionsSchema)
        .where(
          and(
            eq(
              schoolAssignmentSubmissionsSchema.enrollmentId,
              enrollment.enrollmentId
            ),
            eq(schoolAssignmentSubmissionsSchema.studentStatus, "PENDING")
          )
        )
        .get()
    )?.count ?? 0;

  const recentGrades: DashboardGrade[] = await db
    .select({
      examName: schoolExamsSchema.name,
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      remarks: schoolExamMarksSchema.remarks,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamsSchema,
      eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
    )
    .where(eq(schoolExamMarksSchema.enrollmentId, enrollment.enrollmentId))
    .orderBy(desc(schoolExamsSchema.createdAt))
    .limit(5)
    .all();

  return {
    persona: "PARENT",
    stats: {
      ...baseStats,
      myClass: enrollment.className,
      mySection: enrollment.sectionName,
      rollNumber: enrollment.rollNumber ?? undefined,
      attendancePercentage,
      totalDaysTracked: totalDays,
      presentDays,
      absentDays,
      feesCollected: totalPaid, // paise
      feesPending, // paise
      totalFeeDue: totalDue, // paise (effective after concessions)
      totalOriginal, // paise (before concessions)
      totalConcession, // paise
      pendingAssignments,
    },
    lists: { recentGrades, recentNotifications },
  };
}

// ─── GENERAL STAFF ────────────────────────────────────────────────────────────

async function buildGeneralStaffDashboard(db: any): Promise<DashboardData> {
  const recentNotifications = await fetchRecentNotifications(db);
  return {
    persona: "GENERAL_STAFF",
    stats: {},
    lists: { recentNotifications },
  };
}
