// src/modules/school/dashboard/services.ts
// Production-grade, persona-aware dashboard service

import { and, desc, eq, sql } from "drizzle-orm";
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

export interface DashboardStats {
  // Owner / Management
  totalStudents?: number;
  totalTeachers?: number;
  totalStaff?: number;
  currentEnrollments?: number;
  feesCollected?: number;
  feesPending?: number;
  feeCollectionRate?: number;
  activeClassSections?: number;

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

  // Student only
  // (uses shared fields above)

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

// ─── OWNER / MANAGEMENT ───────────────────────────────────────────────────────

async function buildOwnerManagementDashboard(
  db: any,
  persona: DashboardPersona
): Promise<DashboardData> {
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

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

  const feesCollected = currentYear
    ? (
        await db
          .select({
            total: sql<number>`coalesce(sum(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .innerJoin(
            schoolStudentEnrollmentsSchema,
            eq(
              schoolFeePaymentsSchema.enrollmentId,
              schoolStudentEnrollmentsSchema.id
            )
          )
          .where(
            eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id)
          )
          .get()
      )?.total ?? 0
    : 0;

  const feesAssigned = currentYear
    ? (
        await db
          .select({
            total: sql<number>`coalesce(sum(${schoolFeeStructuresSchema.amount}), 0)`,
          })
          .from(schoolFeeStructuresSchema)
          .where(eq(schoolFeeStructuresSchema.academicYearId, currentYear.id))
          .get()
      )?.total ?? 0
    : 0;

  const feesPending = Math.max(0, feesAssigned - feesCollected);
  const feeCollectionRate =
    feesAssigned > 0 ? Math.round((feesCollected / feesAssigned) * 100) : 0;

  const activeClassSections =
    (
      await db
        .select({ count: sql<number>`count(*)` })
        .from(schoolClassSectionsSchema)
        .where(eq(schoolClassSectionsSchema.isActive, true))
        .get()
    )?.count ?? 0;

  const recentNotifications = await fetchRecentNotifications(db);

  return {
    persona,
    stats: {
      totalStudents,
      totalTeachers,
      currentEnrollments,
      feesCollected,
      feesPending,
      feeCollectionRate,
      activeClassSections,
    },
    lists: { recentNotifications },
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
  // ── Guard: no child selected ─────────────────────────────────────────────
  if (!activeChildId) {
    const recentNotifications = await fetchRecentNotifications(db);
    return {
      persona: "PARENT",
      stats: {},
      lists: { recentNotifications },
    };
  }

  // ── Security: verify parent↔child link ──────────────────────────────────
  // student_parents.parent_id = parents.user_id = school_users.id (parentUserId)
  // student_parents.student_id = students.user_id = school_users.id (activeChildId)
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

  // ── Fetch child's school_users row (name, avatar, gender, blood group) ───
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

  // ── Fetch child's student-profile row (admissionDate, medicalInfo, etc.) ─
  const studentProfile = await db
    .select({
      admissionDate: studentsSchema.admissionDate,
      previousSchool: studentsSchema.previousSchool,
      medicalInfo: studentsSchema.medicalInfo,
    })
    .from(studentsSchema)
    .where(eq(studentsSchema.userId, activeChildId))
    .get();

  // ── Fetch current academic year ──────────────────────────────────────────
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  const recentNotifications = await fetchRecentNotifications(db);

  // Base stats available even without enrollment
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

  // ── Fetch child's active enrollment ─────────────────────────────────────
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

  // ── Attendance ───────────────────────────────────────────────────────────
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

  // ── Fees ─────────────────────────────────────────────────────────────────
  const totalDue =
    (
      await db
        .select({
          total: sql<number>`coalesce(sum(${schoolFeeStructuresSchema.amount}), 0)`,
        })
        .from(schoolFeeStructuresSchema)
        .where(
          and(
            eq(
              schoolFeeStructuresSchema.classSectionId,
              enrollment.classSectionId
            ),
            eq(schoolFeeStructuresSchema.academicYearId, currentYear.id)
          )
        )
        .get()
    )?.total ?? 0;

  const totalPaid =
    (
      await db
        .select({
          total: sql<number>`coalesce(sum(${schoolFeePaymentsSchema.amountPaid}), 0)`,
        })
        .from(schoolFeePaymentsSchema)
        .where(
          eq(schoolFeePaymentsSchema.enrollmentId, enrollment.enrollmentId)
        )
        .get()
    )?.total ?? 0;

  const feesPending = Math.max(0, totalDue - totalPaid);

  // ── Pending assignments ──────────────────────────────────────────────────
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

  // ── Recent grades ────────────────────────────────────────────────────────
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
      feesCollected: totalPaid,
      feesPending,
      totalFeeDue: totalDue,
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
