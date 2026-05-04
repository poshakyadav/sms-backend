// src/modules/school/parent/services.ts
// Production-grade parent services: children lookup, child dashboard, parent search & assignment

import { and, desc, eq, like, or } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import {
  parentsSchema,
  schoolAcademicYearsSchema,
  schoolAssignmentSubmissionsSchema,
  schoolAttendancesSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolExamMarksSchema,
  schoolExamsSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolNotificationsSchema,
  schoolRolesSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
  studentParentsSchema,
  studentsSchema,
} from "../../../db/schemas/school";
import { sql } from "drizzle-orm";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

// ==================== TYPES ====================

export interface ParentChild {
  studentId: number;
  studentName: string;
  studentEmail: string;
  studentAvatarUrl?: string;
  relationship: string;
  isPrimary: boolean;
  currentEnrollment: {
    enrollmentId: number;
    className: string;
    sectionName: string;
    rollNumber?: string;
    academicYearName: string;
    isActive: boolean;
  } | null;
}

export interface ParentSearchResult {
  userId: number;
  name: string;
  email: string;
  phone: string;
  avatarUrl?: string;
  occupation?: string;
  linkedStudentCount: number;
}

export interface StudentParentLink {
  parentUserId: number;
  parentName: string;
  parentEmail: string;
  parentPhone: string;
  parentAvatarUrl?: string;
  occupation?: string;
  relationship: string;
  isPrimary: boolean;
  linkId: number;
}

export interface StudentSearchResult {
  id: number;
  name: string;
  email: string;
  avatarUrl?: string;
  rollNumber?: string;
  className?: string;
  sectionName?: string;
  primaryRole: string;
}

// ==================== GET PARENT'S CHILDREN ====================
export async function getParentChildren(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number
): Promise<ParentChild[]> {
  const db = await getSchoolDB(env, schoolCode);

  // Get current academic year
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  // Get all children linked to this parent via student_parents junction
  const links = await db
    .select({
      studentId: studentParentsSchema.studentId,
      relationship: studentParentsSchema.relationship,
      isPrimary: studentParentsSchema.isPrimary,
      studentName: schoolUsersSchema.name,
      studentEmail: schoolUsersSchema.email,
      studentAvatarUrl: schoolUsersSchema.avatarUrl,
    })
    .from(studentParentsSchema)
    .innerJoin(
      studentsSchema,
      eq(studentParentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(studentParentsSchema.parentId, parentUserId))
    .orderBy(studentParentsSchema.isPrimary)
    .all();

  if (links.length === 0) {
    return [];
  }

  // Get current enrollments for each child
  const children: ParentChild[] = [];

  for (const link of links) {
    let currentEnrollment: ParentChild["currentEnrollment"] = null;

    if (currentYear) {
      const enrollment = await db
        .select({
          enrollmentId: schoolStudentEnrollmentsSchema.id,
          className: schoolClassesSchema.name,
          sectionName: schoolSectionsSchema.name,
          rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
          academicYearName: schoolAcademicYearsSchema.name,
          isActive: schoolStudentEnrollmentsSchema.isActive,
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
        .innerJoin(
          schoolAcademicYearsSchema,
          eq(
            schoolStudentEnrollmentsSchema.academicYearId,
            schoolAcademicYearsSchema.id
          )
        )
        .where(
          and(
            eq(schoolStudentEnrollmentsSchema.studentId, link.studentId),
            eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
            eq(schoolStudentEnrollmentsSchema.isActive, true)
          )
        )
        .get();

      if (enrollment) {
        currentEnrollment = {
          enrollmentId: enrollment.enrollmentId,
          className: enrollment.className,
          sectionName: enrollment.sectionName,
          rollNumber: enrollment.rollNumber ?? undefined,
          academicYearName: enrollment.academicYearName,
          isActive: enrollment.isActive,
        };
      }
    }

    children.push({
      studentId: link.studentId,
      studentName: link.studentName,
      studentEmail: link.studentEmail,
      studentAvatarUrl: link.studentAvatarUrl ?? undefined,
      relationship: link.relationship,
      isPrimary: link.isPrimary ?? false,
      currentEnrollment,
    });
  }

  // Sort: primary first, then alphabetically
  children.sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return a.studentName.localeCompare(b.studentName);
  });

  return children;
}

// ==================== GET CHILD DASHBOARD DATA ====================
export async function getParentChildDashboard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Security: Verify parent is actually linked to this student
  const isLinked = await db
    .select({ id: studentParentsSchema.studentId })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.parentId, parentUserId),
        eq(studentParentsSchema.studentId, studentId)
      )
    )
    .get();

  if (!isLinked) {
    throw new Error("Unauthorized");
  }

  // Get current academic year
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) {
    return {
      enrollment: null,
      attendance: null,
      fees: null,
      pendingAssignments: 0,
      recentGrades: [],
      recentNotifications: [],
    };
  }

  // Get current enrollment
  const enrollment = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
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
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) {
    return {
      enrollment: null,
      attendance: null,
      fees: null,
      pendingAssignments: 0,
      recentGrades: [],
      recentNotifications: [],
    };
  }

  // Attendance stats
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

  // Fee summary
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

  // Recent grades
  const recentGrades = await db
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

  // Pending assignments
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

  // Recent notifications
  const recentNotifications = await db
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

  return {
    enrollment: {
      enrollmentId: enrollment.enrollmentId,
      classSectionId: enrollment.classSectionId,
      className: enrollment.className,
      sectionName: enrollment.sectionName,
      rollNumber: enrollment.rollNumber ?? undefined,
      academicYearName: currentYear.name,
      isActive: true,
    },
    attendance: {
      totalDays,
      presentDays,
      absentDays: totalDays - presentDays,
      attendancePercentage,
    },
    fees: {
      totalDue,
      totalPaid,
      balance: totalDue - totalPaid,
    },
    pendingAssignments,
    recentGrades,
    recentNotifications,
  };
}

// ==================== SEARCH PARENTS (admin use) ====================

export async function searchParents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  query: string
): Promise<ParentSearchResult[]> {
  const db = await getSchoolDB(env, schoolCode);

  const searchPattern = `%${query}%`;

  // Find users who have the STUDENT_PARENT role
  const parentUsers = await db
    .select({
      userId: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      phone: schoolUsersSchema.phone,
      avatarUrl: schoolUsersSchema.avatarUrl,
      occupation: parentsSchema.occupation,
    })
    .from(schoolUsersSchema)
    .innerJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .innerJoin(
      schoolUserRolesSchema,
      eq(schoolUsersSchema.id, schoolUserRolesSchema.userId)
    )
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(
      and(
        eq(schoolRolesSchema.name, SchoolRole.STUDENT_PARENT),
        eq(schoolUsersSchema.isActive, true),
        or(
          like(schoolUsersSchema.name, searchPattern),
          like(schoolUsersSchema.email, searchPattern),
          like(schoolUsersSchema.phone, searchPattern)
        )
      )
    )
    .limit(20)
    .all();

  if (parentUsers.length === 0) return [];

  // Count linked students for each parent
  const results: ParentSearchResult[] = [];

  for (const parent of parentUsers) {
    const linkedCount =
      (
        await db
          .select({ count: sql<number>`count(*)` })
          .from(studentParentsSchema)
          .where(eq(studentParentsSchema.parentId, parent.userId))
          .get()
      )?.count ?? 0;

    results.push({
      userId: parent.userId,
      name: parent.name,
      email: parent.email,
      phone: parent.phone,
      avatarUrl: parent.avatarUrl ?? undefined,
      occupation: parent.occupation ?? undefined,
      linkedStudentCount: linkedCount,
    });
  }

  return results;
}

// ==================== GET PARENTS LINKED TO A STUDENT ====================

export async function getStudentParents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number
): Promise<StudentParentLink[]> {
  const db = await getSchoolDB(env, schoolCode);

  // Verify student exists
  const student = await db
    .select({ userId: studentsSchema.userId })
    .from(studentsSchema)
    .where(eq(studentsSchema.userId, studentId))
    .get();

  if (!student) throw new Error("Student not found");

  const links = await db
    .select({
      linkId: studentParentsSchema.id,
      parentUserId: studentParentsSchema.parentId,
      relationship: studentParentsSchema.relationship,
      isPrimary: studentParentsSchema.isPrimary,
      parentName: schoolUsersSchema.name,
      parentEmail: schoolUsersSchema.email,
      parentPhone: schoolUsersSchema.phone,
      parentAvatarUrl: schoolUsersSchema.avatarUrl,
      occupation: parentsSchema.occupation,
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
    .orderBy(studentParentsSchema.isPrimary)
    .all();

  return links.map((l) => ({
    linkId: l.linkId,
    parentUserId: l.parentUserId,
    parentName: l.parentName,
    parentEmail: l.parentEmail,
    parentPhone: l.parentPhone,
    parentAvatarUrl: l.parentAvatarUrl ?? undefined,
    occupation: l.occupation ?? undefined,
    relationship: l.relationship,
    isPrimary: l.isPrimary ?? false,
  }));
}

// ==================== ASSIGN PARENT TO STUDENT ====================

export async function assignParentToStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  parentUserId: number,
  relationship: string,
  isPrimary: boolean
): Promise<{ message: string; linkId: number }> {
  const db = await getSchoolDB(env, schoolCode);

  // Verify student exists
  const student = await db
    .select({ userId: studentsSchema.userId })
    .from(studentsSchema)
    .where(eq(studentsSchema.userId, studentId))
    .get();

  if (!student) throw new Error("Student not found");

  // Verify parent exists and has STUDENT_PARENT role
  const parentCheck = await db
    .select({ userId: parentsSchema.userId })
    .from(parentsSchema)
    .where(eq(parentsSchema.userId, parentUserId))
    .get();

  if (!parentCheck) {
    throw new Error(
      "User is not registered as a parent. Make sure the user has the STUDENT_PARENT role."
    );
  }

  // Check if already linked
  const existing = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.studentId, studentId),
        eq(studentParentsSchema.parentId, parentUserId)
      )
    )
    .get();

  if (existing) {
    throw new Error("This parent is already linked to this student");
  }

  return await db.transaction(async (tx) => {
    // If isPrimary, demote any existing primary parent for this student
    if (isPrimary) {
      await tx
        .update(studentParentsSchema)
        .set({ isPrimary: false })
        .where(
          and(
            eq(studentParentsSchema.studentId, studentId),
            eq(studentParentsSchema.isPrimary, true)
          )
        );
    }

    const [link] = await tx
      .insert(studentParentsSchema)
      .values({
        studentId,
        parentId: parentUserId,
        relationship,
        isPrimary,
      })
      .returning();

    return {
      message: "Parent assigned to student successfully",
      linkId: link.id,
    };
  });
}

// ==================== UPDATE PARENT-STUDENT RELATIONSHIP ====================

export async function updateParentStudentRelationship(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  parentUserId: number,
  data: { relationship?: string; isPrimary?: boolean }
): Promise<void> {
  const db = await getSchoolDB(env, schoolCode);

  const existing = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.studentId, studentId),
        eq(studentParentsSchema.parentId, parentUserId)
      )
    )
    .get();

  if (!existing) throw new Error("Parent-student link not found");

  await db.transaction(async (tx) => {
    if (data.isPrimary) {
      // Demote any other primary
      await tx
        .update(studentParentsSchema)
        .set({ isPrimary: false })
        .where(
          and(
            eq(studentParentsSchema.studentId, studentId),
            eq(studentParentsSchema.isPrimary, true)
          )
        );
    }

    const updateData: any = {};
    if (data.relationship !== undefined)
      updateData.relationship = data.relationship;
    if (data.isPrimary !== undefined) updateData.isPrimary = data.isPrimary;

    if (Object.keys(updateData).length > 0) {
      await tx
        .update(studentParentsSchema)
        .set(updateData)
        .where(
          and(
            eq(studentParentsSchema.studentId, studentId),
            eq(studentParentsSchema.parentId, parentUserId)
          )
        );
    }
  });
}

// ==================== REMOVE PARENT FROM STUDENT ====================

export async function removeParentFromStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  parentUserId: number
): Promise<void> {
  const db = await getSchoolDB(env, schoolCode);

  const existing = await db
    .select({ id: studentParentsSchema.id })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.studentId, studentId),
        eq(studentParentsSchema.parentId, parentUserId)
      )
    )
    .get();

  if (!existing) throw new Error("Parent-student link not found");

  await db
    .delete(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.studentId, studentId),
        eq(studentParentsSchema.parentId, parentUserId)
      )
    );
}

/**
 * Search students by name, email, or roll number.
 * Returns students with their current enrollment info (class + section).
 * Requires: users.list permission (staff who manage users)
 */
export async function searchStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  query: string
): Promise<StudentSearchResult[]> {
  const db = await getSchoolDB(env, schoolCode);

  const searchPattern = `%${query}%`;

  // Get current academic year for enrollment lookup
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  // Find users who are students (have a students profile row)
  const studentUsers = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      avatarUrl: schoolUsersSchema.avatarUrl,
      primaryRole: schoolUsersSchema.primaryRole,
    })
    .from(schoolUsersSchema)
    .innerJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .where(
      and(
        eq(schoolUsersSchema.isActive, true),
        or(
          like(schoolUsersSchema.name, searchPattern),
          like(schoolUsersSchema.email, searchPattern)
        )
      )
    )
    .limit(20)
    .all();

  if (studentUsers.length === 0) return [];

  // Enrich with current enrollment (class + section + roll number)
  const results: StudentSearchResult[] = [];

  for (const student of studentUsers) {
    let className: string | undefined;
    let sectionName: string | undefined;
    let rollNumber: string | undefined;

    if (currentYear) {
      const enrollment = await db
        .select({
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
            eq(schoolStudentEnrollmentsSchema.studentId, student.id),
            eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
            eq(schoolStudentEnrollmentsSchema.isActive, true)
          )
        )
        .get();

      if (enrollment) {
        className = enrollment.className;
        sectionName = enrollment.sectionName;
        rollNumber = enrollment.rollNumber ?? undefined;
      }
    }

    results.push({
      id: student.id,
      name: student.name,
      email: student.email,
      avatarUrl: student.avatarUrl ?? undefined,
      primaryRole: student.primaryRole,
      rollNumber,
      className,
      sectionName,
    });
  }

  return results;
}
