// src/modules/school/users/services.ts
// UPDATED: assignDirectPermissionsToUser now enforces category consistency.
// The target user's primaryRole is read, mapped to a PermissionCategory via
// getProfileCategory(), and all submitted permissionIds are validated against
// that category before any write happens.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  parentsSchema,
  schoolAssignmentsSchema,
  schoolAssignmentSubmissionsSchema,
  schoolAttendancesSchema,
  schoolExamMarksSchema,
  schoolFeePaymentsSchema,
  schoolPermissionsSchema,
  schoolRolesSchema,
  schoolStudentEnrollmentsSchema,
  schoolUserPermissionsSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
  staffSchema,
  studentParentsSchema,
  studentsSchema,
  teachersSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import { hashPassword } from "../../../utils/hashing";
import {
  getProfileCategory,
  getProfileCategoryLabel,
  ProfileTableCategory,
} from "../../../utils/school/profile-mapping";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { getUserPermissionsFromDB } from "../auth/permission-helpers";
import { PermissionCategory } from "../../../types/school-permissions";

// ── Category label map for human-readable error messages ─────────────────────
const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  staff: "Staff",
  student: "Student",
  parent: "Parent",
};

/**
 * Maps a ProfileTableCategory (from profile-mapping.ts) to the
 * PermissionCategory used by the permissions table.
 *
 * 'student' → 'student'
 * 'parent'  → 'parent'
 * 'teacher' → 'staff'  (teachers are staff-category users)
 * 'staff'   → 'staff'
 */
function profileCategoryToPermissionCategory(
  profileCat: ProfileTableCategory
): PermissionCategory {
  switch (profileCat) {
    case "student":
      return "student";
    case "parent":
      return "parent";
    case "teacher":
    case "staff":
    default:
      return "staff";
  }
}

// ── Safe user fields (excludes passwordHash) ──────────────────────────────────
// Use this everywhere users are returned to the API layer.
const SAFE_USER_FIELDS = {
  id: schoolUsersSchema.id,
  schoolId: schoolUsersSchema.schoolId,
  name: schoolUsersSchema.name,
  email: schoolUsersSchema.email,
  primaryRole: schoolUsersSchema.primaryRole,
  tokenVersion: schoolUsersSchema.tokenVersion,
  phone: schoolUsersSchema.phone,
  alternatePhone: schoolUsersSchema.alternatePhone,
  dateOfBirth: schoolUsersSchema.dateOfBirth,
  gender: schoolUsersSchema.gender,
  bloodGroup: schoolUsersSchema.bloodGroup,
  avatarUrl: schoolUsersSchema.avatarUrl,
  addressLineOne: schoolUsersSchema.addressLineOne,
  addressLineTwo: schoolUsersSchema.addressLineTwo,
  city: schoolUsersSchema.city,
  state: schoolUsersSchema.state,
  postalCode: schoolUsersSchema.postalCode,
  isActive: schoolUsersSchema.isActive,
  createdAt: schoolUsersSchema.createdAt,
  updatedAt: schoolUsersSchema.updatedAt,
  // termsAcceptedAt intentionally omitted (not needed in lists)
} as const;
 
// ── Deletion check result — returned BEFORE any DELETE is performed ────────────
export interface DeletionCheckResult {
  canDelete: boolean;
  // If canDelete is false, this is the blocking reason
  blockingReason?: string;
  // Structured warnings shown in the confirmation popup even when canDelete=true
  warnings: DeletionWarning[];
  // Summary counts for display in the popup
  summary: {
    enrollments: number;
    attendanceRecords: number;
    feePayments: number;
    examMarks: number;
    assignments: number;        // only for teachers
    submissions: number;        // only for students
    linkedChildren: number;     // only for parents
    linkedParents: number;      // only for students
  };
  userInfo: {
    name: string;
    primaryRole: string;
    isActive: boolean;
  };
}
 
export interface DeletionWarning {
  severity: "info" | "warning" | "danger";
  message: string;
}

// ==================== TYPE DEFINITIONS ====================
interface CreateUserData {
  name: string;
  email: string;
  password: string;
  primaryRoleId: number;
  roleIds: number[];
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: string;
  gender?: string;
  bloodGroup?: string;
  avatarUrl?: string;
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  // Student-specific
  rollNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;
  // Teacher-specific
  qualification?: string;
  experienceYears?: number;
  specialization?: string;
  // Parent-specific
  occupation?: string;
  // Staff-specific
  department?: string;
  salary?: number;
  shift?: string;
  joiningDate?: string;
}

interface UpdateUserData {
  name?: string;
  email?: string;
  newPassword?: string;
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: string;
  gender?: string;
  bloodGroup?: string;
  avatarUrl?: string;
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  isActive?: boolean;
  // Profile-specific fields (routed via primaryRole)
  rollNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;
  qualification?: string;
  experienceYears?: number;
  specialization?: string;
  occupation?: string;
  department?: string;
  salary?: number;
  shift?: string;
  joiningDate?: string;
}

// ── Internal helper: load roles for a batch of userIds ───────────────────────
async function loadRolesForUsers(db: any, userIds: number[]) {
  if (userIds.length === 0) return {} as Record<number, any[]>;
 
  const rolesData = await db
    .select({
      userId: schoolUserRolesSchema.userId,
      roleId: schoolRolesSchema.id,
      roleName: schoolRolesSchema.name,
      roleDescription: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(inArray(schoolUserRolesSchema.userId, userIds))
    .all();
 
  return rolesData.reduce((acc: Record<number, any[]>, role: any) => {
    if (!acc[role.userId]) acc[role.userId] = [];
    acc[role.userId].push({
      id: role.roleId,
      name: role.roleName,
      description: role.roleDescription,
      isSystem: role.isSystem,
      category: role.category,
    });
    return acc;
  }, {});
}
 
// ── Internal helper: map a joined row to a safe user object ──────────────────
function mapUserRow(
  row: { user: any; student: any; teacher: any; parent: any; staff: any },
  rolesByUser: Record<number, any[]>
) {
  // Destructure to explicitly exclude passwordHash
  const {
    passwordHash: _omit,
    ...safeUser
  } = row.user as any;
 
  return {
    ...safeUser,
    roles: rolesByUser[safeUser.id] || [],
    profile: determineProfileFromPrimaryRole(row, safeUser.primaryRole),
  };
}

// ==================== GET ALL USERS (WITH ROLES) ====================
/** 
export async function getSchoolUsers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const usersWithProfiles = await db
    .select({
      user: schoolUsersSchema,
      student: studentsSchema,
      teacher: teachersSchema,
      parent: parentsSchema,
      staff: staffSchema,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .orderBy(schoolUsersSchema.name)
    .all();

  const userIds = usersWithProfiles.map((u) => u.user.id);

  const rolesData =
    userIds.length > 0
      ? await db
          .select({
            userId: schoolUserRolesSchema.userId,
            roleId: schoolRolesSchema.id,
            roleName: schoolRolesSchema.name,
            roleDescription: schoolRolesSchema.description,
            isSystem: schoolRolesSchema.isSystem,
            category: schoolRolesSchema.category,
          })
          .from(schoolUserRolesSchema)
          .innerJoin(
            schoolRolesSchema,
            eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
          )
          .where(inArray(schoolUserRolesSchema.userId, userIds))
          .all()
      : [];

  const rolesByUser = rolesData.reduce((acc, role) => {
    if (!acc[role.userId]) acc[role.userId] = [];
    acc[role.userId].push({
      id: role.roleId,
      name: role.roleName,
      description: role.roleDescription,
      isSystem: role.isSystem,
      category: role.category,
    });
    return acc;
  }, {} as Record<number, any[]>);

  return usersWithProfiles.map((row) => ({
    ...row.user,
    roles: rolesByUser[row.user.id] || [],
    profile: determineProfileFromPrimaryRole(row, row.user.primaryRole),
  }));
}
*/

// ==================== GET ALL USERS (WITH ROLES, NO PASSWORD) ====================
export async function getSchoolUsers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);
 
  const usersWithProfiles = await db
    .select({
      user: schoolUsersSchema,   // passwordHash excluded via mapUserRow
      student: studentsSchema,
      teacher: teachersSchema,
      parent: parentsSchema,
      staff: staffSchema,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .orderBy(schoolUsersSchema.name)
    .all();
 
  const userIds = usersWithProfiles.map((u) => u.user.id);
  const rolesByUser = await loadRolesForUsers(db, userIds);
 
  return usersWithProfiles.map((row) => mapUserRow(row, rolesByUser));
}

// ==================== GET USERS BY CATEGORY (tab-based) =======================
//
// category: 'staff' | 'student' | 'parent'
//
// Maps to primaryRole universe:
//   staff   → primaryRole NOT IN (STUDENT, STUDENT_PARENT)
//   student → primaryRole = STUDENT (or any role with student profile category)
//   parent  → primaryRole = STUDENT_PARENT (or any role with parent profile category)
//
// NEVER returns passwordHash.
export async function getSchoolUsersByCategory(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  category: PermissionCategory
) {
  const db = await getSchoolDB(env, schoolCode);
 
  // Determine which primaryRole values belong to this category.
  // We query the roles table so custom roles created by the school owner
  // are also handled correctly.
  const rolesInCategory = await db
    .select({ name: schoolRolesSchema.name })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.category, category))
    .all();
 
  const roleNames = rolesInCategory.map((r: { name: string }) => r.name);
 
  if (roleNames.length === 0) {
    return [];
  }
 
  const usersWithProfiles = await db
    .select({
      user: schoolUsersSchema,
      student: studentsSchema,
      teacher: teachersSchema,
      parent: parentsSchema,
      staff: staffSchema,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(inArray(schoolUsersSchema.primaryRole, roleNames))
    .orderBy(schoolUsersSchema.name)
    .all();
 
  const userIds = usersWithProfiles.map((u: any) => u.user.id);
  const rolesByUser = await loadRolesForUsers(db, userIds);
 
  return usersWithProfiles.map((row: any) => mapUserRow(row, rolesByUser));
}

// ==================== GET USER BY ID (WITH ROLES) ====================
/** 
export async function getSchoolUserById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const userWithProfile = await db
    .select({
      user: schoolUsersSchema,
      student: studentsSchema,
      teacher: teachersSchema,
      parent: parentsSchema,
      staff: staffSchema,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(eq(schoolUsersSchema.id, id))
    .get();

  if (!userWithProfile) return null;

  const roles = await db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, id))
    .all();

  return {
    ...userWithProfile.user,
    roles,
    profile: determineProfileFromPrimaryRole(
      userWithProfile,
      userWithProfile.user.primaryRole
    ),
  };
}
*/

// ==================== GET USER BY ID (WITH ROLES, NO PASSWORD) ================
export async function getSchoolUserById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);
 
  const userWithProfile = await db
    .select({
      user: schoolUsersSchema,
      student: studentsSchema,
      teacher: teachersSchema,
      parent: parentsSchema,
      staff: staffSchema,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(eq(schoolUsersSchema.id, id))
    .get();
 
  if (!userWithProfile) return null;
 
  const roles = await db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, id))
    .all();
 
  // Exclude passwordHash
  const { passwordHash: _omit, ...safeUser } = userWithProfile.user as any;
 
  return {
    ...safeUser,
    roles,
    profile: determineProfileFromPrimaryRole(
      userWithProfile,
      userWithProfile.user.primaryRole
    ),
  };
}

// ==================== PRE-DELETE DEPENDENCY CHECK ============================
//
// Call this BEFORE attempting deletion. Returns a DeletionCheckResult that
// the frontend uses to build a rich confirmation dialog.
//
// Blocking conditions (canDelete = false):
//   - Student has active (isActive=true) enrollments
//   - Teacher is the sole class teacher for any active class-section
//     (not blocking but a strong warning)
//
// Non-blocking warnings:
//   - Any historical data will become orphaned / anonymised
export async function checkUserDeletionImpact(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
): Promise<DeletionCheckResult> {
  const db = await getSchoolDB(env, schoolCode);
 
  // 1. Load user
  const user = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      primaryRole: schoolUsersSchema.primaryRole,
      isActive: schoolUsersSchema.isActive,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();
 
  if (!user) {
    return {
      canDelete: false,
      blockingReason: "User not found.",
      warnings: [],
      summary: { enrollments: 0, attendanceRecords: 0, feePayments: 0, examMarks: 0, assignments: 0, submissions: 0, linkedChildren: 0, linkedParents: 0 },
      userInfo: { name: "Unknown", primaryRole: "Unknown", isActive: false },
    };
  }
 
  const profileCat = getProfileCategory(user.primaryRole);
  const warnings: DeletionWarning[] = [];
  let canDelete = true;
  let blockingReason: string | undefined;
 
  // ── Counts ────────────────────────────────────────────────────────────────
  let enrollmentCount = 0;
  let activeEnrollmentCount = 0;
  let attendanceCount = 0;
  let feePaymentCount = 0;
  let examMarkCount = 0;
  let assignmentCount = 0;
  let submissionCount = 0;
  let linkedChildrenCount = 0;
  let linkedParentsCount = 0;
 
  // ── 2. STUDENT CHECKS ─────────────────────────────────────────────────────
  if (profileCat === "student") {
    const enrollments = await db
      .select({
        id: schoolStudentEnrollmentsSchema.id,
        isActive: schoolStudentEnrollmentsSchema.isActive,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.studentId, userId))
      .all();
 
    enrollmentCount = enrollments.length;
    activeEnrollmentCount = enrollments.filter((e: any) => e.isActive).length;
 
    if (activeEnrollmentCount > 0) {
      canDelete = false;
      blockingReason = `This student has ${activeEnrollmentCount} active enrollment${activeEnrollmentCount > 1 ? "s" : ""}. You must unenroll the student before deletion. Consider deactivating the account instead.`;
    }
 
    // Fee payments
    const feePaymentsRows = enrollments.length > 0
      ? await db
          .select({ id: schoolFeePaymentsSchema.id })
          .from(schoolFeePaymentsSchema)
          .where(
            inArray(
              schoolFeePaymentsSchema.enrollmentId,
              enrollments.map((e: any) => e.id)
            )
          )
          .all()
      : [];
    feePaymentCount = feePaymentsRows.length;
 
    // Attendance
    const attendanceRows = enrollments.length > 0
      ? await db
          .select({ id: schoolAttendancesSchema.id })
          .from(schoolAttendancesSchema)
          .where(
            inArray(
              schoolAttendancesSchema.enrollmentId,
              enrollments.map((e: any) => e.id)
            )
          )
          .all()
      : [];
    attendanceCount = attendanceRows.length;
 
    // Exam marks
    const examMarkRows = enrollments.length > 0
      ? await db
          .select({ id: schoolExamMarksSchema.id })
          .from(schoolExamMarksSchema)
          .where(
            inArray(
              schoolExamMarksSchema.enrollmentId,
              enrollments.map((e: any) => e.id)
            )
          )
          .all()
      : [];
    examMarkCount = examMarkRows.length;
 
    // Assignment submissions
    const submissionRows = enrollments.length > 0
      ? await db
          .select({ id: schoolAssignmentSubmissionsSchema.id })
          .from(schoolAssignmentSubmissionsSchema)
          .where(
            inArray(
              schoolAssignmentSubmissionsSchema.enrollmentId,
              enrollments.map((e: any) => e.id)
            )
          )
          .all()
      : [];
    submissionCount = submissionRows.length;
 
    // Linked parents
    const linkedParentRows = await db
      .select({ parentId: studentParentsSchema.parentId })
      .from(studentParentsSchema)
      .where(eq(studentParentsSchema.studentId, userId))
      .all();
    linkedParentsCount = linkedParentRows.length;
 
    // Build warnings
    if (!canDelete && activeEnrollmentCount > 0) {
      warnings.push({
        severity: "danger",
        message: `Student has ${activeEnrollmentCount} active enrollment(s). Deletion is blocked until unenrolled.`,
      });
    }
    if (feePaymentCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${feePaymentCount} fee payment record(s) will be permanently deleted. This cannot be undone.`,
      });
    }
    if (attendanceCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${attendanceCount} attendance record(s) across all enrollments will be deleted.`,
      });
    }
    if (examMarkCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${examMarkCount} exam mark record(s) will be permanently deleted.`,
      });
    }
    if (submissionCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${submissionCount} assignment submission(s) will be deleted.`,
      });
    }
    if (linkedParentsCount > 0) {
      warnings.push({
        severity: "info",
        message: `${linkedParentsCount} linked parent account(s) will be unlinked but not deleted.`,
      });
    }
  }
 
  // ── 3. TEACHER / STAFF CHECKS ─────────────────────────────────────────────
  if (profileCat === "teacher") {
    // Check assignments created by this teacher
    const assignmentRows = await db
      .select({ id: schoolAssignmentsSchema.id })
      .from(schoolAssignmentsSchema)
      .where(eq(schoolAssignmentsSchema.enteredBy, userId))
      .all();
    assignmentCount = assignmentRows.length;
 
    if (assignmentCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${assignmentCount} assignment(s) created by this teacher will be deleted along with all student submissions.`,
      });
    }
 
    // Attendance records marked by this teacher
    const attendanceRows = await db
      .select({ id: schoolAttendancesSchema.id })
      .from(schoolAttendancesSchema)
      .where(eq(schoolAttendancesSchema.markedBy, userId))
      .all();
    attendanceCount = attendanceRows.length;
 
    if (attendanceCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${attendanceCount} attendance record(s) marked by this teacher — the 'marked by' reference will be cleared.`,
      });
    }
 
    // Exam marks entered by this teacher
    const examMarkRows = await db
      .select({ id: schoolExamMarksSchema.id })
      .from(schoolExamMarksSchema)
      .where(eq(schoolExamMarksSchema.enteredBy, userId))
      .all();
    examMarkCount = examMarkRows.length;
 
    if (examMarkCount > 0) {
      warnings.push({
        severity: "warning",
        message: `${examMarkCount} exam mark entry/entries recorded by this teacher — the 'entered by' reference will be cleared.`,
      });
    }
  }
 
  // ── 4. PARENT CHECKS ──────────────────────────────────────────────────────
  if (profileCat === "parent") {
    const childRows = await db
      .select({ studentId: studentParentsSchema.studentId })
      .from(studentParentsSchema)
      .where(eq(studentParentsSchema.parentId, userId))
      .all();
    linkedChildrenCount = childRows.length;
 
    if (linkedChildrenCount > 0) {
      warnings.push({
        severity: "warning",
        message: `This parent is linked to ${linkedChildrenCount} student(s). Deleting will remove all parent-child links. Student accounts will NOT be deleted.`,
      });
    }
  }
 
  // ── 5. Universal warning for any non-trivial user ─────────────────────────
  if (canDelete) {
    warnings.push({
      severity: "danger",
      message: "This action is permanent and cannot be undone. The account will be completely removed from the system.",
    });
  }
 
  if (user.isActive && canDelete) {
    warnings.push({
      severity: "info",
      message: "Tip: Consider deactivating the account instead of deleting if you may need to restore this user's data in the future.",
    });
  }
 
  return {
    canDelete,
    blockingReason,
    warnings,
    summary: {
      enrollments: enrollmentCount,
      attendanceRecords: attendanceCount,
      feePayments: feePaymentCount,
      examMarks: examMarkCount,
      assignments: assignmentCount,
      submissions: submissionCount,
      linkedChildren: linkedChildrenCount,
      linkedParents: linkedParentsCount,
    },
    userInfo: {
      name: user.name,
      primaryRole: user.primaryRole,
      isActive: user.isActive,
    },
  };
}

// ==================== CREATE USER (PRODUCTION-GRADE) ====================
export async function createSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: CreateUserData,
  createdBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // ── 1. VALIDATE: primaryRoleId must be in roleIds ──────────────────────
    if (!data.roleIds.includes(data.primaryRoleId)) {
      throw new Error(
        "Primary role must be included in the assigned roles list."
      );
    }

    // ── 2. VALIDATE ALL ROLE IDs EXIST ────────────────────────────────────
    const validRoles = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(inArray(schoolRolesSchema.id, data.roleIds))
      .all();

    if (validRoles.length !== data.roleIds.length) {
      throw new Error("One or more invalid role IDs provided.");
    }

    // ── 3. VALIDATE PRIMARY ROLE EXISTS IN FETCHED ROLES ─────────────────
    const primaryRoleRecord = validRoles.find(
      (r) => r.id === data.primaryRoleId
    );
    if (!primaryRoleRecord) {
      throw new Error("Primary role ID is invalid.");
    }

    const primaryRoleName = primaryRoleRecord.name;
    const profileCategory = getProfileCategory(primaryRoleName);

    // ── 4. CHECK EMAIL UNIQUENESS ──────────────────────────────────────────
    const existingUser = await tx
      .select({ id: schoolUsersSchema.id })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.email, data.email))
      .get();

    if (existingUser) {
      throw new Error(
        "This email address is already registered in this school."
      );
    }

    // ── 5. HASH PASSWORD ───────────────────────────────────────────────────
    const passwordHash = await hashPassword(data.password);

    // ── 6. CREATE BASE USER (with primaryRole persisted) ──────────────────
    const [newUser] = await tx
      .insert(schoolUsersSchema)
      .values({
        name: data.name,
        email: data.email,
        passwordHash,
        primaryRole: primaryRoleName,
        phone: data.phone || "",
        alternatePhone: data.alternatePhone || "",
        dateOfBirth: data.dateOfBirth || "",
        gender: data.gender || "",
        addressLineOne: data.addressLineOne || "",
        addressLineTwo: data.addressLineTwo || "",
        city: data.city || "",
        state: data.state || "",
        postalCode: data.postalCode || "",
        bloodGroup: data.bloodGroup || "",
        avatarUrl: data.avatarUrl || "",
        tokenVersion: 0,
      })
      .returning();

    // ── 7. ASSIGN ALL ROLES ────────────────────────────────────────────────
    await tx.insert(schoolUserRolesSchema).values(
      data.roleIds.map((roleId) => ({
        userId: newUser.id,
        roleId,
      }))
    );

    // ── 8. CREATE PROFILE based on profileCategory ─────────────────────────
    await createUserProfile(
      tx,
      newUser.id,
      profileCategory,
      primaryRoleName,
      data
    );

    // ── 9. SEND WELCOME EMAIL ──────────────────────────────────────────────
    const roleNames = validRoles.map((r) => r.name).join(", ");
    const emailData: BrevoSendEmailRequest = {
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: data.email, name: data.name }],
      subject: `Welcome to ${schoolCode} — Your Account is Ready`,
      htmlContent: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e40af;">Welcome, ${data.name}!</h2>
          <p>Your <strong>${getProfileCategoryLabel(
            primaryRoleName
          )}</strong> account has been created.</p>
          <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; background: #f8fafc; font-weight: 600;">Email</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${
                data.email
              }</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; background: #f8fafc; font-weight: 600;">Password</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${
                data.password
              }</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; background: #f8fafc; font-weight: 600;">Primary Role</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${primaryRoleName.replace(
                /_/g,
                " "
              )}</td>
            </tr>
          </table>
          <p style="color: #dc2626;"><strong>Important:</strong> Please change your password after your first login.</p>
        </div>
      `,
    };

    await sendTransactionalEmail(env, emailData).catch((err) => {
      console.error("Welcome email failed (non-fatal):", err);
    });

    return {
      user: {
        ...newUser,
        roles: validRoles,
        primaryRole: primaryRoleName,
      },
    };
  });
}

// ==================== UPDATE USER ====================
export async function updateSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: UpdateUserData,
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // ── 1. FETCH EXISTING USER (including primaryRole) ────────────────────
    const existingUser = await tx
      .select({
        id: schoolUsersSchema.id,
        email: schoolUsersSchema.email,
        name: schoolUsersSchema.name,
        tokenVersion: schoolUsersSchema.tokenVersion,
        primaryRole: schoolUsersSchema.primaryRole,
      })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, id))
      .get();

    if (!existingUser) {
      throw new Error("User not found.");
    }

    // ── 2. CHECK EMAIL UNIQUENESS ──────────────────────────────────────────
    if (data.email && data.email !== existingUser.email) {
      const emailTaken = await tx
        .select({ id: schoolUsersSchema.id })
        .from(schoolUsersSchema)
        .where(
          and(
            eq(schoolUsersSchema.email, data.email),
            sql`${schoolUsersSchema.id} != ${id}`
          )
        )
        .get();

      if (emailTaken) {
        throw new Error("This email address is already in use.");
      }
    }

    // ── 3. BUILD UPDATE DATA ───────────────────────────────────────────────
    const updateData: any = { updatedAt: sql`CURRENT_TIMESTAMP` };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.alternatePhone !== undefined)
      updateData.alternatePhone = data.alternatePhone;
    if (data.dateOfBirth !== undefined)
      updateData.dateOfBirth = data.dateOfBirth;
    if (data.gender !== undefined) updateData.gender = data.gender;
    if (data.addressLineOne !== undefined)
      updateData.addressLineOne = data.addressLineOne;
    if (data.addressLineTwo !== undefined)
      updateData.addressLineTwo = data.addressLineTwo;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.postalCode !== undefined) updateData.postalCode = data.postalCode;
    if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
    if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    // ── 4. PASSWORD CHANGE → increment tokenVersion ────────────────────────
    if (data.newPassword) {
      updateData.passwordHash = await hashPassword(data.newPassword);
      updateData.tokenVersion = existingUser.tokenVersion + 1;
    }

    // ── 5. UPDATE BASE USER ────────────────────────────────────────────────
    await tx
      .update(schoolUsersSchema)
      .set(updateData)
      .where(eq(schoolUsersSchema.id, id));

    // ── 6. UPDATE PROFILE using primaryRole ───────────────────────────────
    const profileCategory = getProfileCategory(existingUser.primaryRole);
    await updateUserProfile(tx, id, profileCategory, data);

    // ── 7. SEND EMAIL IF PASSWORD CHANGED ─────────────────────────────────
    if (data.newPassword) {
      const emailData: BrevoSendEmailRequest = {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [
          {
            email: data.email || existingUser.email,
            name: data.name || existingUser.name,
          },
        ],
        subject: "Your Password Has Been Updated",
        htmlContent: `
          <p>Hello ${data.name || existingUser.name},</p>
          <p>Your password has been successfully updated by an administrator.</p>
          <p>New password: <strong>${data.newPassword}</strong></p>
          <p><em>Please log in and change it immediately for security.</em></p>
        `,
      };

      await sendTransactionalEmail(env, emailData).catch((err) => {
        console.error("Password update email failed (non-fatal):", err);
      });
    }

    return { message: "User updated successfully" };
  });
}

// ==================== ASSIGN ROLES TO USER ====================
export async function assignRolesToUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  roleIds: number[],
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // ── 1. FETCH USER ─────────────────────────────────────────────────────
    const user = await tx
      .select({
        id: schoolUsersSchema.id,
        name: schoolUsersSchema.name,
        email: schoolUsersSchema.email,
        tokenVersion: schoolUsersSchema.tokenVersion,
        primaryRole: schoolUsersSchema.primaryRole,
      })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, userId))
      .get();

    if (!user) {
      throw new Error("User not found.");
    }

    // ── 2. VALIDATE ALL INCOMING ROLE IDs ─────────────────────────────────
    const validRoles = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(inArray(schoolRolesSchema.id, roleIds))
      .all();

    if (validRoles.length !== roleIds.length) {
      throw new Error("One or more invalid role IDs provided.");
    }

    // ── 3. PRIMARY ROLE IMMUTABILITY GUARD ────────────────────────────────
    const primaryRoleRecord = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.name, user.primaryRole))
      .get();

    if (!primaryRoleRecord) {
      throw new Error(
        `Integrity error: primary role "${user.primaryRole}" no longer exists in the roles table. ` +
          `Please contact support.`
      );
    }

    if (!roleIds.includes(primaryRoleRecord.id)) {
      throw new Error(
        `Cannot remove the primary role "${user.primaryRole.replace(
          /_/g,
          " "
        )}" from this user. ` +
          `The primary role is permanent and defines the user's identity in this school. ` +
          `If this user's role needs to fundamentally change, please create a new account.`
      );
    }

    // ── 4. SCHOOL_OWNER LAST-OWNER GUARD ──────────────────────────────────
    if (user.primaryRole === SchoolRole.SCHOOL_OWNER) {
      const otherOwners = await tx
        .select({ id: schoolUsersSchema.id })
        .from(schoolUsersSchema)
        .where(
          and(
            eq(schoolUsersSchema.primaryRole, SchoolRole.SCHOOL_OWNER),
            sql`${schoolUsersSchema.id} != ${userId}`,
            eq(schoolUsersSchema.isActive, true)
          )
        )
        .all();

      if (otherOwners.length === 0) {
        const incomingHasOwner = validRoles.some(
          (r) => r.name === SchoolRole.SCHOOL_OWNER
        );
        if (!incomingHasOwner) {
          throw new Error(
            "Cannot remove the School Owner role from the last active school owner. " +
              "Please assign another user as School Owner first."
          );
        }
      }
    }

    // ── 5. REPLACE ROLE ASSIGNMENTS ───────────────────────────────────────
    await tx
      .delete(schoolUserRolesSchema)
      .where(eq(schoolUserRolesSchema.userId, userId));

    await tx
      .insert(schoolUserRolesSchema)
      .values(roleIds.map((roleId) => ({ userId, roleId })));

    // ── 6. INVALIDATE TOKENS ───────────────────────────────────────────────
    const newTokenVersion = user.tokenVersion + 1;
    await tx
      .update(schoolUsersSchema)
      .set({ tokenVersion: newTokenVersion })
      .where(eq(schoolUsersSchema.id, userId));

    // ── 7. FETCH NEW PERMISSIONS (for logging) ─────────────────────────────
    const newPermissions = await getUserPermissionsFromDB(tx, userId);
    console.log(
      `🔄 Role update for user ${userId} | primaryRole: ${
        user.primaryRole
      } | new roles: ${validRoles
        .map((r) => r.name)
        .join(", ")} | permissions: ${newPermissions.length}`
    );

    // ── 8. SEND NOTIFICATION EMAIL ─────────────────────────────────────────
    const emailData: BrevoSendEmailRequest = {
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: user.email, name: user.name }],
      subject: "Your Roles Have Been Updated",
      htmlContent: `
        <p>Hello ${user.name},</p>
        <p>Your roles have been updated by an administrator.</p>
        <p><strong>Primary Role (permanent):</strong> ${user.primaryRole.replace(
          /_/g,
          " "
        )}</p>
        <p><strong>All Current Roles:</strong></p>
        <ul>${validRoles
          .map((r) => `<li>${r.name.replace(/_/g, " ")}</li>`)
          .join("")}</ul>
        <p><em>Your previous sessions have been invalidated for security. Please log in again.</em></p>
      `,
    };

    await sendTransactionalEmail(env, emailData).catch((err) => {
      console.error("Role update email failed (non-fatal):", err);
    });

    return {
      message: "Roles updated successfully.",
      primaryRole: user.primaryRole,
      newPermissions: newPermissions.length,
      tokenVersion: newTokenVersion,
    };
  });
}

// ==================== GET USER ROLES ====================
export async function getUserRoles(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
      category: schoolRolesSchema.category,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, userId))
    .all();
}

// ==================== GET USER DIRECT PERMISSIONS ====================
export async function getUserDirectPermissions(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolPermissionsSchema.id,
      slug: schoolPermissionsSchema.slug,
      name: schoolPermissionsSchema.name,
      module: schoolPermissionsSchema.module,
      category: schoolPermissionsSchema.category,
    })
    .from(schoolUserPermissionsSchema)
    .innerJoin(
      schoolPermissionsSchema,
      eq(schoolUserPermissionsSchema.permissionId, schoolPermissionsSchema.id)
    )
    .where(eq(schoolUserPermissionsSchema.userId, userId))
    .all();
}

// ==================== ASSIGN DIRECT PERMISSIONS ====================
// UPDATED: Enforces category consistency — submitted permissionIds must all
// belong to the same permission universe as the user's primaryRole.
export async function assignDirectPermissionsToUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  permissionIds: number[],
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // 1. Verify user exists and read their primaryRole
    const user = await tx
      .select({
        id: schoolUsersSchema.id,
        tokenVersion: schoolUsersSchema.tokenVersion,
        primaryRole: schoolUsersSchema.primaryRole,
      })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, userId))
      .get();

    if (!user) {
      throw new Error("User not found");
    }

    // 2. Derive the expected permission category from the user's primaryRole
    const profileCat = getProfileCategory(user.primaryRole);
    const expectedCategory = profileCategoryToPermissionCategory(profileCat);

    // 3. Validate permissions exist AND belong to the correct category
    if (permissionIds.length > 0) {
      const perms = await tx
        .select({
          id: schoolPermissionsSchema.id,
          slug: schoolPermissionsSchema.slug,
          category: schoolPermissionsSchema.category,
        })
        .from(schoolPermissionsSchema)
        .where(inArray(schoolPermissionsSchema.id, permissionIds))
        .all();

      // Check for IDs that don't exist in the DB at all
      if (perms.length !== permissionIds.length) {
        throw new Error("One or more invalid permission IDs");
      }

      // Check for category mismatches
      const wrongCategory = perms.filter(
        (p: { id: number; slug: string; category: string }) =>
          p.category !== expectedCategory
      );

      if (wrongCategory.length > 0) {
        const slugList = wrongCategory
          .map(
            (p: { slug: string; category: string }) =>
              `"${p.slug}" (${
                CATEGORY_LABELS[p.category as PermissionCategory] ?? p.category
              })`
          )
          .join(", ");

        throw new Error(
          `Category mismatch: The following permissions do not belong to the ` +
            `"${CATEGORY_LABELS[expectedCategory]}" category: ${slugList}. ` +
            `Only ${CATEGORY_LABELS[expectedCategory]} permissions can be assigned to this user ` +
            `(their primary role is "${user.primaryRole}").`
        );
      }
    }

    // 4. Delete existing direct permissions
    await tx
      .delete(schoolUserPermissionsSchema)
      .where(eq(schoolUserPermissionsSchema.userId, userId));

    // 5. Insert new permissions
    if (permissionIds.length > 0) {
      await tx.insert(schoolUserPermissionsSchema).values(
        permissionIds.map((permissionId) => ({
          userId,
          permissionId,
        }))
      );
    }

    // 6. Increment token version to invalidate existing sessions
    await tx
      .update(schoolUsersSchema)
      .set({ tokenVersion: user.tokenVersion + 1 })
      .where(eq(schoolUsersSchema.id, userId));

    console.log(
      `🔄 Updated direct permissions for user ${userId} ` +
        `(primaryRole: ${user.primaryRole}, category: ${expectedCategory}, ` +
        `count: ${permissionIds.length})`
    );

    return { message: "Permissions updated successfully" };
  });
}

// ==================== DELETE USER =============================================
// NOTE: Call checkUserDeletionImpact() first and present results to the user.
// This function should only be called after explicit confirmation.
export async function deleteSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);
 
  // Final safety check — active enrollments are a hard block
  const activeEnrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .limit(1)
    .get();
 
  if (activeEnrollment) {
    throw new Error(
      "Cannot delete a student with active enrollments. Please unenroll the student first, or deactivate the account instead."
    );
  }
 
  await db.delete(schoolUsersSchema).where(eq(schoolUsersSchema.id, id));
  return { message: "User deleted successfully" };
}

// ==================== PROFILE HELPERS ====================

function determineProfileFromPrimaryRole(row: any, primaryRole: string) {
  const category = getProfileCategory(primaryRole || "");
  switch (category) {
    case "student":
      return row.student ? { type: "student", data: row.student } : null;
    case "teacher":
      return row.teacher ? { type: "teacher", data: row.teacher } : null;
    case "parent":
      return row.parent ? { type: "parent", data: row.parent } : null;
    case "staff":
      return row.staff ? { type: "staff", data: row.staff } : null;
    default:
      return null;
  }
}

async function createUserProfile(
  tx: any,
  userId: number,
  category: ProfileTableCategory,
  primaryRoleName: string,
  data: CreateUserData
) {
  switch (category) {
    case "student":
      await tx.insert(studentsSchema).values({
        userId,
        rollNumber: data.rollNumber || "",
        admissionDate: data.admissionDate || "",
        previousSchool: data.previousSchool || "",
        medicalInfo: data.medicalInfo || "",
      });
      break;

    case "teacher":
      await tx.insert(teachersSchema).values({
        userId,
        qualification: data.qualification || "",
        experienceYears: data.experienceYears || 0,
        joiningDate: data.joiningDate || "",
        specialization: data.specialization || "",
      });
      break;

    case "parent":
      await tx.insert(parentsSchema).values({
        userId,
        occupation: data.occupation || "",
        address: "",
      });
      break;

    case "staff":
    default:
      await tx.insert(staffSchema).values({
        userId,
        designation: primaryRoleName,
        department: data.department || "",
        joiningDate: data.joiningDate || "",
        salary: data.salary || 0,
        shift: data.shift || "",
      });
      break;
  }
}

async function updateUserProfile(
  tx: any,
  userId: number,
  category: ProfileTableCategory,
  data: UpdateUserData
) {
  const updateData: any = {};

  switch (category) {
    case "student":
      if (data.rollNumber !== undefined)
        updateData.rollNumber = data.rollNumber;
      if (data.admissionDate !== undefined)
        updateData.admissionDate = data.admissionDate;
      if (data.previousSchool !== undefined)
        updateData.previousSchool = data.previousSchool;
      if (data.medicalInfo !== undefined)
        updateData.medicalInfo = data.medicalInfo;

      if (Object.keys(updateData).length > 0) {
        await tx
          .update(studentsSchema)
          .set(updateData)
          .where(eq(studentsSchema.userId, userId));
      }
      break;

    case "teacher":
      if (data.qualification !== undefined)
        updateData.qualification = data.qualification;
      if (data.experienceYears !== undefined)
        updateData.experienceYears = data.experienceYears;
      if (data.specialization !== undefined)
        updateData.specialization = data.specialization;
      if (data.joiningDate !== undefined)
        updateData.joiningDate = data.joiningDate;

      if (Object.keys(updateData).length > 0) {
        await tx
          .update(teachersSchema)
          .set(updateData)
          .where(eq(teachersSchema.userId, userId));
      }
      break;

    case "parent":
      if (data.occupation !== undefined)
        updateData.occupation = data.occupation;

      if (Object.keys(updateData).length > 0) {
        await tx
          .update(parentsSchema)
          .set(updateData)
          .where(eq(parentsSchema.userId, userId));
      }
      break;

    case "staff":
    default:
      if (data.department !== undefined)
        updateData.department = data.department;
      if (data.joiningDate !== undefined)
        updateData.joiningDate = data.joiningDate;
      if (data.salary !== undefined) updateData.salary = data.salary;
      if (data.shift !== undefined) updateData.shift = data.shift;

      if (Object.keys(updateData).length > 0) {
        const existingStaff = await tx
          .select({ userId: staffSchema.userId })
          .from(staffSchema)
          .where(eq(staffSchema.userId, userId))
          .get();

        if (existingStaff) {
          await tx
            .update(staffSchema)
            .set(updateData)
            .where(eq(staffSchema.userId, userId));
        } else {
          await tx.insert(staffSchema).values({
            userId,
            designation: "STAFF",
            department: updateData.department ?? "",
            joiningDate: updateData.joiningDate ?? "",
            salary: updateData.salary ?? 0,
            shift: updateData.shift ?? "",
          });
        }
      }
      break;
  }
}
