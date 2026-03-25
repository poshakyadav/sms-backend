// src/modules/school/dashboard/services.ts

import { and, desc, eq, sql } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import {
  schoolAcademicYearsSchema,
  schoolAssignmentSubmissionsSchema,
  schoolAttendancesSchema,
  schoolClassSectionsSchema,
  schoolClassSubjectsSchema,
  schoolClassesSchema,
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
  staffSchema,
  studentsSchema,
  teachersSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

/**
 * DASHBOARD DATA INTERFACE
 * Centralized shape for all roles. Easy to extend later.
 */
interface DashboardData {
  role: SchoolRole;
  stats: Record<string, number | string>;
  lists: Record<string, any[]>;
  quickLinks: string[]; // e.g., ["/users", "/academics/years"]
}


/**
 * GET DASHBOARD DATA
 *
 * Purpose: Returns role-specific dashboard stats, recent lists, and quick links.
 * This is the single entry point for the dashboard page across all roles.
 *
 * How it works:
 * 1. Fetches current academic year (shared for all roles)
 * 2. Switches on user.role and builds role-specific data
 * 3. Uses classSectionId joins everywhere (new schema compliant)
 *
 * @param user - From JWT middleware (contains id + role)
 * @returns DashboardData object
 */
export async function getDashboardData(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  user: any
): Promise<DashboardData> {
  const db = await getSchoolDB(env, schoolCode);

  // Get current academic year (common for all roles)
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) {
    throw new Error("No current academic year found", {
      cause: { status: 404 },
    });
  }

  let data: DashboardData = {
    role: user.role,
    stats: {},
    lists: {},
    quickLinks: [],
  };

  switch (user.role) {
    case SchoolRole.SCHOOL_OWNER:
    case SchoolRole.PRINCIPAL:
    case SchoolRole.MANAGER: // Similar high-level access
      // Stats: Total users by type
      data.stats.totalStudents =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(studentsSchema)
            .get()
        )?.count || 0;
      data.stats.totalTeachers =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(teachersSchema)
            .get()
        )?.count || 0;
      data.stats.totalStaff =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(staffSchema)
            .get()
        )?.count || 0;

      // Enrollments this year
      data.stats.currentEnrollments =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(schoolStudentEnrollmentsSchema)
            .where(
              eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id)
            )
            .get()
        )?.count || 0;

      // Fees: Collected vs Pending (aggregate)
      const collected =
        (
          await db
            .select({
              total: sql<number>`sum(${schoolFeePaymentsSchema.amountPaid})`,
            })
            .from(schoolFeePaymentsSchema)
            .get()
        )?.total || 0;
      const totalDue =
        (
          await db
            .select({
              total: sql<number>`sum(${schoolFeeStructuresSchema.amount})`,
            })
            .from(schoolFeeStructuresSchema)
            .where(eq(schoolFeeStructuresSchema.academicYearId, currentYear.id))
            .get()
        )?.total || 0;
      data.stats.feesCollected = collected;
      data.stats.feesPending = totalDue - collected;

      // Recent notifications (last 5)
      data.lists.recentNotifications = await db
        .select()
        .from(schoolNotificationsSchema)
        .orderBy(desc(schoolNotificationsSchema.createdAt))
        .limit(5)
        .all();

      data.quickLinks = [
        "/users",
        "/academics/years",
        "/academics/classes",
        "/academics/sections",
        "/academics/enroll",
        "/fees/structures",
        "/fees/payments",
        "/fees/report",
        "/fees/ledger",
        "/attendance",
      ];
      break;

    case SchoolRole.TEACHER:
      // Assigned classes/subjects
      const assignments = await db
        .select({
          class: schoolClassesSchema.name,
          subject: schoolSubjectsSchema.name,
          section: schoolSectionsSchema.name,
        })
        .from(schoolTeacherAssignmentsSchema)
        .innerJoin(
          schoolClassSubjectsSchema,
          eq(
            schoolTeacherAssignmentsSchema.classSubjectId,
            schoolClassSubjectsSchema.id
          )
        )
        .innerJoin(
          schoolClassesSchema,
          eq(schoolClassSubjectsSchema.classId, schoolClassesSchema.id)
        )
        .innerJoin(
          schoolSubjectsSchema,
          eq(schoolClassSubjectsSchema.subjectId, schoolSubjectsSchema.id)
        )
        .leftJoin(
          schoolSectionsSchema,
          eq(schoolClassesSchema.id, schoolSectionsSchema.schoolId)
        ) // Adjust if needed
        .where(eq(schoolTeacherAssignmentsSchema.teacherId, user.id))
        .all();
      data.lists.assignedClasses = assignments;

      // Today's attendances to mark (enrollments in assigned classes)
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
      data.stats.attendancesToMark =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(schoolAttendancesSchema)
            .where(
              and(
                eq(schoolAttendancesSchema.date, today),
                eq(schoolAttendancesSchema.markedBy, user.id)
              )
            )
            .get()
        )?.count || 0;

      // Upcoming exams/assignments (next 7 days, limit 5)
      data.lists.upcomingExams = await db
        .select()
        .from(schoolExamsSchema)
        .where(
          and(
            sql`${schoolExamsSchema.date} > CURRENT_DATE`,
            sql`${schoolExamsSchema.date} <= date(CURRENT_DATE, '+7 days')`
          )
        )
        .limit(5)
        .all();

      // Pending submissions (for my assignments)
      // Use correct dual-status column for Teacher
      data.stats.pendingSubmissions = (
        await db
          .select({ count: sql<number>`count(*)` })
          .from(schoolAssignmentSubmissionsSchema)
          .where(
            and(
              eq(schoolAssignmentSubmissionsSchema.teacherStatus, "NOT_RECEIVED"), // Teacher's pending
              eq(schoolAssignmentSubmissionsSchema.enteredBy, user.id)
            )
          )
          .get()
      )?.count || 0;

      data.quickLinks = ["/attendance", "/assignments", "/exams"];
      break;

    case SchoolRole.STUDENT:
      // My current enrollment (using classSectionId)
      const enrollment = await db
        .select({
          id: schoolStudentEnrollmentsSchema.id,
          className: schoolClassesSchema.name,
          sectionName: schoolSectionsSchema.name,
        })
        .from(schoolStudentEnrollmentsSchema)
        .innerJoin(
          schoolClassSectionsSchema,
          eq(schoolStudentEnrollmentsSchema.classSectionId, schoolClassSectionsSchema.id)
        )
        .innerJoin(schoolClassesSchema, eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id))
        .innerJoin(schoolSectionsSchema, eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id))
        .where(
          and(
            eq(schoolStudentEnrollmentsSchema.studentId, user.id),
            eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
            eq(schoolStudentEnrollmentsSchema.isActive, true)
          )
        )
        .get();
        data.stats.myClass = enrollment?.className || "N/A";
        data.stats.mySection = enrollment?.sectionName || "N/A";

      // Attendance summary (percentage this year) - fixed: added filter to totalDays for this enrollment
      const totalDays =
        (
          await db
            .select({
              count: sql<number>`count(distinct ${schoolAttendancesSchema.date})`,
            })
            .from(schoolAttendancesSchema)
            .where(
              eq(schoolAttendancesSchema.enrollmentId, enrollment?.id || 0)
            ) // Added filter
            .get()
        )?.count || 0;
      const presentDays =
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(schoolAttendancesSchema)
            .where(
              and(
                eq(schoolAttendancesSchema.enrollmentId, enrollment?.id || 0),
                eq(schoolAttendancesSchema.status, "PRESENT")
              )
            )
            .get()
        )?.count || 0;
      data.stats.attendancePercentage = totalDays
        ? Math.round((presentDays / totalDays) * 100)
        : 0;

      // Recent grades (last 5 marks)
      data.lists.recentGrades = await db
        .select({
          exam: schoolExamsSchema.name,
          marks: schoolExamMarksSchema.marksObtained,
          grade: schoolExamMarksSchema.grade,
        })
        .from(schoolExamMarksSchema)
        .innerJoin(
          schoolExamsSchema,
          eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
        )
        .where(eq(schoolExamMarksSchema.enrollmentId, enrollment?.id || 0))
        .orderBy(desc(schoolExamsSchema.date))
        .limit(5)
        .all();

      // Due assignments (pending for me)
      // Use correct dual-status column for Student
      data.lists.dueAssignments = await db
        .select()
        .from(schoolAssignmentSubmissionsSchema)
        .where(
          and(
            eq(schoolAssignmentSubmissionsSchema.enrollmentId, enrollment?.id || 0),
            eq(schoolAssignmentSubmissionsSchema.studentStatus, "PENDING") // ← Correct column
          )
        )
        .limit(5)
        .all();

      data.quickLinks = ["/assignments", "/exams", "/fees"];
      break;

    default:
      // Staff: Fetch designation and handle accordingly
      const staffProfile = await db
        .select()
        .from(staffSchema)
        .where(eq(staffSchema.userId, user.id))
        .get();
      if (!staffProfile)
        throw new Error("Staff profile not found", { cause: { status: 404 } });

      switch (staffProfile.designation) {
        case "ACCOUNTANT":
          // Fees stats similar to owner but limited
          const staffCollected =
            (
              await db
                .select({
                  total: sql<number>`sum(${schoolFeePaymentsSchema.amountPaid})`,
                })
                .from(schoolFeePaymentsSchema)
                .where(eq(schoolFeePaymentsSchema.recordedBy, user.id))
                .get()
            )?.total || 0;
          data.stats.feesCollectedByMe = staffCollected;
          data.stats.pendingPayments =
            (
              await db
                .select({ count: sql<number>`count(*)` })
                .from(schoolFeeStructuresSchema)
                .leftJoin(
                  schoolFeePaymentsSchema,
                  eq(
                    schoolFeeStructuresSchema.id,
                    schoolFeePaymentsSchema.feeStructureId
                  )
                )
                .where(sql`${schoolFeePaymentsSchema.id} IS NULL`)
                .get()
            )?.count || 0;

          data.quickLinks = [
            "/fees/structures",
            "/fees/payments",
            "/fees/report",
            "/fees/ledger",
          ];
          break;

        // Add cases for other designations (e.g., LIBRARIAN: book stats if schema added)
        default:
          // Fallback for general staff
          data.stats.generalNotifications =
            (
              await db
                .select({ count: sql<number>`count(*)` })
                .from(schoolNotificationsSchema)
                .get()
            )?.count || 0;
          data.quickLinks = ["/notifications"];
      }

      // Common for all staff: Recent notifications
      data.lists.recentNotifications = await db
        .select()
        .from(schoolNotificationsSchema)
        .orderBy(desc(schoolNotificationsSchema.createdAt))
        .limit(5)
        .all();
      break;
  }

  return data;
}
