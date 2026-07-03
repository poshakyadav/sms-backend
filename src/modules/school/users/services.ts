// src/modules/school/users/services.ts

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
  schoolUserPermissionDenialsSchema,
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
import { deleteUserAvatar, uploadUserAvatar } from "../../../utils/school/avatar-storage";

// Helper to get frontend URL
const getFrontendUrlForUsers = (env: SchoolEnv["Bindings"]): string => {
  return env.FRONTEND_ORIGIN || "http://localhost:4200";
};

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  staff: "Staff",
  student: "Student",
  parent: "Parent",
};

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

// ─────────────────────────────────────────────────────────────────────────────
// SAFE FIELD SELECTORS
// schoolUsersSchema fields that are always safe to return (no passwordHash).
// Now includes fatherName, motherName, guardianName, guardianRelation.
// ─────────────────────────────────────────────────────────────────────────────

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

  // ── Parental / guardian fields (UDISE+ & general HR) ──────────────────────
  fatherName: schoolUsersSchema.fatherName,
  motherName: schoolUsersSchema.motherName,
  guardianName: schoolUsersSchema.guardianName,
  guardianRelation: schoolUsersSchema.guardianRelation,

  // ── T&C + lifecycle ───────────────────────────────────────────────────────
  termsAcceptedAt: schoolUsersSchema.termsAcceptedAt,
  isActive: schoolUsersSchema.isActive,
  createdAt: schoolUsersSchema.createdAt,
  updatedAt: schoolUsersSchema.updatedAt,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// INLINE ROLES SUB-SELECT
// Returns a JSON array of all roles assigned to this user.
// ─────────────────────────────────────────────────────────────────────────────

const rolesSubSelect = sql<string>`(
  SELECT JSON_GROUP_ARRAY(
    JSON_OBJECT(
      'id',          r.id,
      'name',        r.name,
      'description', COALESCE(r.description, ''),
      'isSystem',    r.is_system,
      'category',    r.category
    )
  )
  FROM user_roles ur
  INNER JOIN roles r ON ur.role_id = r.id
  WHERE ur.user_id = ${schoolUsersSchema.id}
)`.as("roles_json");

function parseRolesJson(raw: string | null): Array<{
  id: number;
  name: string;
  description: string;
  isSystem: boolean;
  category: string;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse facilitiesReceived JSON string → string array (safe). */
function parseFacilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETION CHECK TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface DeletionCheckResult {
  canDelete: boolean;
  blockingReason?: string;
  warnings: DeletionWarning[];
  summary: {
    enrollments: number;
    attendanceRecords: number;
    feePayments: number;
    examMarks: number;
    assignments: number;
    submissions: number;
    linkedChildren: number;
    linkedParents: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

interface CreateUserData {
  // Core
  name: string;
  email: string;
  password: string;
  primaryRoleId: number;
  roleIds: number[];

  // Common (school_users)
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

  // ── NEW: Parental / guardian fields (school_users) ────────────────────────
  fatherName?: string;
  motherName?: string;
  guardianName?: string;
  guardianRelation?: string;

  // ── Student school-internal fields (students) ─────────────────────────────
  admissionNumber?: string;
  rollNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;

  // ── UDISE / National identity fields (students) ───────────────────────────
  pen?: string | null;
  apaarId?: string | null;
  stateStudentId?: string | null;
  aadhaarMasked?: string | null;
  aadhaarName?: string | null;
  previousSchoolUdiseCode?: string | null;

  // ── UDISE+ demographic fields (students) ──────────────────────────────────
  enrollmentType?: string;
  previousClassResult?: string | null;
  socialCategory?: number | null;
  religion?: number | null;
  isMinority?: boolean;
  motherTongueCode?: number | null;

  // ── Socio-economic (students) ─────────────────────────────────────────────
  isBpl?: boolean;
  localityType?: string | null;

  // ── CWSN (students) ───────────────────────────────────────────────────────
  isCwsn?: boolean;
  disabilityType?: number | null;
  hasDisabilityCertificate?: boolean;
  udidNumber?: string | null;

  // ── Facilities / schemes (students) ──────────────────────────────────────
  facilitiesReceived?: string[];

  // ── Verification flags (students) ─────────────────────────────────────────
  isAadhaarVerified?: boolean;
  udiseVerified?: boolean;

  // ── Teacher profile ───────────────────────────────────────────────────────
  qualification?: string;
  experienceYears?: number;
  specialization?: string;

  // ── Parent profile ────────────────────────────────────────────────────────
  occupation?: string;

  // ── Staff profile ─────────────────────────────────────────────────────────
  department?: string;
  salary?: number;
  shift?: string;
  joiningDate?: string;
}

interface UpdateUserData {
  // Core (mutable)
  name?: string;
  email?: string;
  newPassword?: string;
  isActive?: boolean;

  // Common (school_users)
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

  // ── NEW: Parental / guardian fields (school_users) ────────────────────────
  fatherName?: string;
  motherName?: string;
  guardianName?: string;
  guardianRelation?: string;

  // ── Student school-internal ───────────────────────────────────────────────
  admissionNumber?: string;
  rollNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;

  // ── UDISE / National identity ─────────────────────────────────────────────
  pen?: string | null;
  apaarId?: string | null;
  stateStudentId?: string | null;
  aadhaarMasked?: string | null;
  aadhaarName?: string | null;
  previousSchoolUdiseCode?: string | null;

  // ── UDISE+ demographic ────────────────────────────────────────────────────
  enrollmentType?: string;
  previousClassResult?: string | null;
  socialCategory?: number | null;
  religion?: number | null;
  isMinority?: boolean;
  motherTongueCode?: number | null;

  // ── Socio-economic ────────────────────────────────────────────────────────
  isBpl?: boolean;
  localityType?: string | null;

  // ── CWSN ─────────────────────────────────────────────────────────────────
  isCwsn?: boolean;
  disabilityType?: number | null;
  hasDisabilityCertificate?: boolean;
  udidNumber?: string | null;

  // ── Facilities / schemes ──────────────────────────────────────────────────
  facilitiesReceived?: string[];

  // ── Verification flags ────────────────────────────────────────────────────
  isAadhaarVerified?: boolean;
  udiseVerified?: boolean;

  // ── Teacher profile ───────────────────────────────────────────────────────
  qualification?: string;
  experienceYears?: number;
  specialization?: string;

  // ── Parent profile ────────────────────────────────────────────────────────
  occupation?: string;

  // ── Staff profile ─────────────────────────────────────────────────────────
  department?: string;
  salary?: number;
  shift?: string;
  joiningDate?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE STUDENT FIELDS SELECTOR
// Used in every SELECT that joins the students table.
// All existing + new UDISE fields are projected here.
// ─────────────────────────────────────────────────────────────────────────────

const STUDENT_SELECT_FIELDS = {
  // Existing
  studentUserId: studentsSchema.userId,
  admissionNumber: studentsSchema.admissionNumber,
  rollNumber: studentsSchema.rollNumber,
  admissionDate: studentsSchema.admissionDate,
  previousSchool: studentsSchema.previousSchool,
  medicalInfo: studentsSchema.medicalInfo,
  enrollmentType: studentsSchema.enrollmentType,

  // UDISE / National identity
  pen: studentsSchema.pen,
  apaarId: studentsSchema.apaarId,
  stateStudentId: studentsSchema.stateStudentId,
  aadhaarMasked: studentsSchema.aadhaarMasked,
  aadhaarName: studentsSchema.aadhaarName,
  previousSchoolUdiseCode: studentsSchema.previousSchoolUdiseCode,

  // UDISE+ demographic
  previousClassResult: studentsSchema.previousClassResult,
  socialCategory: studentsSchema.socialCategory,
  religion: studentsSchema.religion,
  isMinority: studentsSchema.isMinority,
  motherTongueCode: studentsSchema.motherTongueCode,

  // Socio-economic
  isBpl: studentsSchema.isBpl,
  localityType: studentsSchema.localityType,

  // CWSN
  isCwsn: studentsSchema.isCwsn,
  disabilityType: studentsSchema.disabilityType,
  hasDisabilityCertificate: studentsSchema.hasDisabilityCertificate,
  udidNumber: studentsSchema.udidNumber,

  // Facilities
  facilitiesReceived: studentsSchema.facilitiesReceived,

  // Verification flags
  isAadhaarVerified: studentsSchema.isAadhaarVerified,
  udiseVerified: studentsSchema.udiseVerified,
} as const;

/** Map raw DB row fields → a typed student profile data object. */
function extractStudentProfile(row: any): Record<string, any> | null {
  if (row.studentUserId == null) return null;
  return {
    userId: row.studentUserId,
    admissionNumber: row.admissionNumber,
    rollNumber: row.rollNumber,
    admissionDate: row.admissionDate,
    previousSchool: row.previousSchool,
    medicalInfo: row.medicalInfo,
    enrollmentType: row.enrollmentType ?? "REGULAR",
    // UDISE / National identity
    pen: row.pen,
    apaarId: row.apaarId,
    stateStudentId: row.stateStudentId,
    aadhaarMasked: row.aadhaarMasked,
    aadhaarName: row.aadhaarName,
    previousSchoolUdiseCode: row.previousSchoolUdiseCode,
    // UDISE+ demographic
    previousClassResult: row.previousClassResult,
    socialCategory: row.socialCategory,
    religion: row.religion,
    isMinority: row.isMinority ?? false,
    motherTongueCode: row.motherTongueCode,
    // Socio-economic
    isBpl: row.isBpl ?? false,
    localityType: row.localityType,
    // CWSN
    isCwsn: row.isCwsn ?? false,
    disabilityType: row.disabilityType,
    hasDisabilityCertificate: row.hasDisabilityCertificate ?? false,
    udidNumber: row.udidNumber,
    // Facilities
    facilitiesReceived: parseFacilities(row.facilitiesReceived),
    // Verification flags
    isAadhaarVerified: row.isAadhaarVerified ?? false,
    udiseVerified: row.udiseVerified ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL USERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getSchoolUsers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const rows = await db
    .select({
      ...SAFE_USER_FIELDS,
      rolesJson: rolesSubSelect,

      // ── Student profile (full — including all UDISE fields) ───────────────
      ...STUDENT_SELECT_FIELDS,

      // ── Teacher profile ───────────────────────────────────────────────────
      teacherUserId: teachersSchema.userId,
      qualification: teachersSchema.qualification,
      experienceYears: teachersSchema.experienceYears,
      teacherJoiningDate: teachersSchema.joiningDate,
      specialization: teachersSchema.specialization,

      // ── Parent profile ────────────────────────────────────────────────────
      parentUserId: parentsSchema.userId,
      occupation: parentsSchema.occupation,
      address: parentsSchema.address,

      // ── Staff profile ─────────────────────────────────────────────────────
      staffUserId: staffSchema.userId,
      designation: staffSchema.designation,
      department: staffSchema.department,
      staffJoiningDate: staffSchema.joiningDate,
      salary: staffSchema.salary,
      shift: staffSchema.shift,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .orderBy(schoolUsersSchema.name)
    .all();

  return rows.map(mapAllCategoriesRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET USERS BY CATEGORY
// ─────────────────────────────────────────────────────────────────────────────

export async function getSchoolUsersByCategory(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  category: PermissionCategory
) {
  const db = await getSchoolDB(env, schoolCode);

  const rolesInCategory: { name: string }[] = await db
    .select({ name: schoolRolesSchema.name })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.category, category))
    .all();

  const roleNames = rolesInCategory.map((r) => r.name);
  if (roleNames.length === 0) return [];

  switch (category) {
    // ── STUDENT — full UDISE fields ───────────────────────────────────────────
    case "student": {
      const rows = await db
        .select({
          ...SAFE_USER_FIELDS,
          rolesJson: rolesSubSelect,
          ...STUDENT_SELECT_FIELDS,
        })
        .from(schoolUsersSchema)
        .leftJoin(
          studentsSchema,
          eq(schoolUsersSchema.id, studentsSchema.userId)
        )
        .where(inArray(schoolUsersSchema.primaryRole, roleNames))
        .orderBy(schoolUsersSchema.name)
        .all();

      return rows.map((row: any) => {
        const { rolesJson, ...rest } = row;
        const studentProfile = extractStudentProfile(rest);

        // Strip all student-specific fields from the base user object
        const safeUser = omitStudentFields(rest);

        return {
          ...safeUser,
          roles: parseRolesJson(rolesJson),
          profile: studentProfile
            ? { type: "student", data: studentProfile }
            : null,
        };
      });
    }

    // ── PARENT ────────────────────────────────────────────────────────────────
    case "parent": {
      const rows = await db
        .select({
          ...SAFE_USER_FIELDS,
          rolesJson: rolesSubSelect,
          parentUserId: parentsSchema.userId,
          occupation: parentsSchema.occupation,
          address: parentsSchema.address,
        })
        .from(schoolUsersSchema)
        .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
        .where(inArray(schoolUsersSchema.primaryRole, roleNames))
        .orderBy(schoolUsersSchema.name)
        .all();

      return rows.map((row: any) => {
        const { rolesJson, parentUserId, occupation, address, ...safeUser } =
          row;
        return {
          ...safeUser,
          roles: parseRolesJson(rolesJson),
          profile:
            parentUserId != null
              ? {
                  type: "parent",
                  data: { userId: parentUserId, occupation, address },
                }
              : null,
        };
      });
    }

    // ── STAFF ─────────────────────────────────────────────────────────────────
    case "staff":
    default: {
      const rows = await db
        .select({
          ...SAFE_USER_FIELDS,
          rolesJson: rolesSubSelect,
          teacherUserId: teachersSchema.userId,
          qualification: teachersSchema.qualification,
          experienceYears: teachersSchema.experienceYears,
          teacherJoiningDate: teachersSchema.joiningDate,
          specialization: teachersSchema.specialization,
          staffUserId: staffSchema.userId,
          designation: staffSchema.designation,
          department: staffSchema.department,
          staffJoiningDate: staffSchema.joiningDate,
          salary: staffSchema.salary,
          shift: staffSchema.shift,
        })
        .from(schoolUsersSchema)
        .leftJoin(
          teachersSchema,
          eq(schoolUsersSchema.id, teachersSchema.userId)
        )
        .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
        .where(inArray(schoolUsersSchema.primaryRole, roleNames))
        .orderBy(schoolUsersSchema.name)
        .all();

      return rows.map((row: any) => {
        const {
          rolesJson,
          teacherUserId,
          qualification,
          experienceYears,
          teacherJoiningDate,
          specialization,
          staffUserId,
          designation,
          department,
          staffJoiningDate,
          salary,
          shift,
          ...safeUser
        } = row;

        let profile: { type: string; data: Record<string, any> } | null = null;
        if (teacherUserId != null) {
          profile = {
            type: "teacher",
            data: {
              userId: teacherUserId,
              qualification,
              experienceYears,
              joiningDate: teacherJoiningDate,
              specialization,
            },
          };
        } else if (staffUserId != null) {
          profile = {
            type: "staff",
            data: {
              userId: staffUserId,
              designation,
              department,
              joiningDate: staffJoiningDate,
              salary,
              shift,
            },
          };
        }

        return { ...safeUser, roles: parseRolesJson(rolesJson), profile };
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET USER BY ID — full UDISE fields for student profile
// ─────────────────────────────────────────────────────────────────────────────

export async function getSchoolUserById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const row = await db
    .select({
      ...SAFE_USER_FIELDS,
      rolesJson: rolesSubSelect,

      // Student — full
      ...STUDENT_SELECT_FIELDS,

      // Teacher
      teacherUserId: teachersSchema.userId,
      qualification: teachersSchema.qualification,
      experienceYears: teachersSchema.experienceYears,
      teacherJoiningDate: teachersSchema.joiningDate,
      specialization: teachersSchema.specialization,

      // Parent
      parentUserId: parentsSchema.userId,
      occupation: parentsSchema.occupation,
      address: parentsSchema.address,

      // Staff
      staffUserId: staffSchema.userId,
      designation: staffSchema.designation,
      department: staffSchema.department,
      staffJoiningDate: staffSchema.joiningDate,
      salary: staffSchema.salary,
      shift: staffSchema.shift,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(eq(schoolUsersSchema.id, id))
    .get();

  if (!row) return null;
  return mapAllCategoriesRow(row);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL MAP — flat row → shaped user object
// ─────────────────────────────────────────────────────────────────────────────

function omitStudentFields(row: any): any {
  // Remove all student-specific fields from the top-level user object
  const {
    studentUserId,
    admissionNumber,
    rollNumber,
    admissionDate,
    previousSchool,
    medicalInfo,
    enrollmentType,
    pen,
    apaarId,
    stateStudentId,
    aadhaarMasked,
    aadhaarName,
    previousSchoolUdiseCode,
    previousClassResult,
    socialCategory,
    religion,
    isMinority,
    motherTongueCode,
    isBpl,
    localityType,
    isCwsn,
    disabilityType,
    hasDisabilityCertificate,
    udidNumber,
    facilitiesReceived,
    isAadhaarVerified,
    udiseVerified,
    ...rest
  } = row;
  return rest;
}

function mapAllCategoriesRow(row: any) {
  const {
    rolesJson,
    // teacher fields
    teacherUserId,
    qualification,
    experienceYears,
    teacherJoiningDate,
    specialization,
    // parent fields
    parentUserId,
    occupation,
    address,
    // staff fields
    staffUserId,
    designation,
    department,
    staffJoiningDate,
    salary,
    shift,
    ...rest
  } = row;

  // Extract student profile (includes all UDISE fields) — then strip from base
  const studentProfile = extractStudentProfile(rest);
  const safeUser = omitStudentFields(rest);

  let profile: { type: string; data: Record<string, any> } | null = null;

  if (studentProfile) {
    profile = { type: "student", data: studentProfile };
  } else if (teacherUserId != null) {
    profile = {
      type: "teacher",
      data: {
        userId: teacherUserId,
        qualification,
        experienceYears,
        joiningDate: teacherJoiningDate,
        specialization,
      },
    };
  } else if (parentUserId != null) {
    profile = {
      type: "parent",
      data: { userId: parentUserId, occupation, address },
    };
  } else if (staffUserId != null) {
    profile = {
      type: "staff",
      data: {
        userId: staffUserId,
        designation,
        department,
        joiningDate: staffJoiningDate,
        salary,
        shift,
      },
    };
  }

  return { ...safeUser, roles: parseRolesJson(rolesJson), profile };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-DELETE DEPENDENCY CHECK
// ─────────────────────────────────────────────────────────────────────────────

export async function checkUserDeletionImpact(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
): Promise<DeletionCheckResult> {
  const db = await getSchoolDB(env, schoolCode);

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
      summary: {
        enrollments: 0,
        attendanceRecords: 0,
        feePayments: 0,
        examMarks: 0,
        assignments: 0,
        submissions: 0,
        linkedChildren: 0,
        linkedParents: 0,
      },
      userInfo: { name: "Unknown", primaryRole: "Unknown", isActive: false },
    };
  }

  const profileCat = getProfileCategory(user.primaryRole);
  const warnings: DeletionWarning[] = [];
  let canDelete = true;
  let blockingReason: string | undefined;

  let enrollmentCount = 0;
  let activeEnrollmentCount = 0;
  let attendanceCount = 0;
  let feePaymentCount = 0;
  let examMarkCount = 0;
  let assignmentCount = 0;
  let submissionCount = 0;
  let linkedChildrenCount = 0;
  let linkedParentsCount = 0;

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
      blockingReason = `This student has ${activeEnrollmentCount} active enrollment${
        activeEnrollmentCount > 1 ? "s" : ""
      }. You must unenroll the student before deletion. Consider deactivating the account instead.`;
    }

    const enrollmentIds = enrollments.map((e: any) => e.id);

    const feePaymentsRows =
      enrollmentIds.length > 0
        ? await db
            .select({ id: schoolFeePaymentsSchema.id })
            .from(schoolFeePaymentsSchema)
            .where(inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds))
            .all()
        : [];
    feePaymentCount = feePaymentsRows.length;

    const attendanceRows =
      enrollmentIds.length > 0
        ? await db
            .select({ id: schoolAttendancesSchema.id })
            .from(schoolAttendancesSchema)
            .where(inArray(schoolAttendancesSchema.enrollmentId, enrollmentIds))
            .all()
        : [];
    attendanceCount = attendanceRows.length;

    const examMarkRows =
      enrollmentIds.length > 0
        ? await db
            .select({ id: schoolExamMarksSchema.id })
            .from(schoolExamMarksSchema)
            .where(inArray(schoolExamMarksSchema.enrollmentId, enrollmentIds))
            .all()
        : [];
    examMarkCount = examMarkRows.length;

    const submissionRows =
      enrollmentIds.length > 0
        ? await db
            .select({ id: schoolAssignmentSubmissionsSchema.id })
            .from(schoolAssignmentSubmissionsSchema)
            .where(
              inArray(
                schoolAssignmentSubmissionsSchema.enrollmentId,
                enrollmentIds
              )
            )
            .all()
        : [];
    submissionCount = submissionRows.length;

    const linkedParentRows = await db
      .select({ parentId: studentParentsSchema.parentId })
      .from(studentParentsSchema)
      .where(eq(studentParentsSchema.studentId, userId))
      .all();
    linkedParentsCount = linkedParentRows.length;

    if (activeEnrollmentCount > 0)
      warnings.push({
        severity: "danger",
        message: `Student has ${activeEnrollmentCount} active enrollment(s). Deletion is blocked until unenrolled.`,
      });
    if (feePaymentCount > 0)
      warnings.push({
        severity: "warning",
        message: `${feePaymentCount} fee payment record(s) will be permanently deleted. This cannot be undone.`,
      });
    if (attendanceCount > 0)
      warnings.push({
        severity: "warning",
        message: `${attendanceCount} attendance record(s) across all enrollments will be deleted.`,
      });
    if (examMarkCount > 0)
      warnings.push({
        severity: "warning",
        message: `${examMarkCount} exam mark record(s) will be permanently deleted.`,
      });
    if (submissionCount > 0)
      warnings.push({
        severity: "warning",
        message: `${submissionCount} assignment submission(s) will be deleted.`,
      });
    if (linkedParentsCount > 0)
      warnings.push({
        severity: "info",
        message: `${linkedParentsCount} linked parent account(s) will be unlinked but not deleted.`,
      });
  }

  if (profileCat === "teacher") {
    const assignmentRows = await db
      .select({ id: schoolAssignmentsSchema.id })
      .from(schoolAssignmentsSchema)
      .where(eq(schoolAssignmentsSchema.enteredBy, userId))
      .all();
    assignmentCount = assignmentRows.length;
    if (assignmentCount > 0)
      warnings.push({
        severity: "warning",
        message: `${assignmentCount} assignment(s) created by this teacher will be deleted along with all student submissions.`,
      });

    const attendanceRows = await db
      .select({ id: schoolAttendancesSchema.id })
      .from(schoolAttendancesSchema)
      .where(eq(schoolAttendancesSchema.markedBy, userId))
      .all();
    attendanceCount = attendanceRows.length;
    if (attendanceCount > 0)
      warnings.push({
        severity: "warning",
        message: `${attendanceCount} attendance record(s) marked by this teacher — the 'marked by' reference will be cleared.`,
      });

    const examMarkRows = await db
      .select({ id: schoolExamMarksSchema.id })
      .from(schoolExamMarksSchema)
      .where(eq(schoolExamMarksSchema.enteredBy, userId))
      .all();
    examMarkCount = examMarkRows.length;
    if (examMarkCount > 0)
      warnings.push({
        severity: "warning",
        message: `${examMarkCount} exam mark entry/entries recorded by this teacher — the 'entered by' reference will be cleared.`,
      });
  }

  if (profileCat === "parent") {
    const childRows = await db
      .select({ studentId: studentParentsSchema.studentId })
      .from(studentParentsSchema)
      .where(eq(studentParentsSchema.parentId, userId))
      .all();
    linkedChildrenCount = childRows.length;
    if (linkedChildrenCount > 0)
      warnings.push({
        severity: "warning",
        message: `This parent is linked to ${linkedChildrenCount} student(s). Deleting will remove all parent-child links. Student accounts will NOT be deleted.`,
      });
  }

  if (canDelete) {
    warnings.push({
      severity: "danger",
      message:
        "This action is permanent and cannot be undone. The account will be completely removed from the system.",
    });
  }
  if (user.isActive && canDelete) {
    warnings.push({
      severity: "info",
      message:
        "Tip: Consider deactivating the account instead of deleting if you may need to restore this user's data in the future.",
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

// ─────────────────────────────────────────────────────────────────────────────
// CREATE USER
// ─────────────────────────────────────────────────────────────────────────────

export async function createSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: CreateUserData,
  createdBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // ── Guard: primaryRoleId must be in roleIds ─────────────────────────────
    if (!data.roleIds.includes(data.primaryRoleId)) {
      throw new Error(
        "Primary role must be included in the assigned roles list."
      );
    }

    // ── Validate role IDs ───────────────────────────────────────────────────
    const validRoles = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(inArray(schoolRolesSchema.id, data.roleIds))
      .all();

    if (validRoles.length !== data.roleIds.length) {
      throw new Error("One or more invalid role IDs provided.");
    }

    const primaryRoleRecord = validRoles.find(
      (r) => r.id === data.primaryRoleId
    );
    if (!primaryRoleRecord) throw new Error("Primary role ID is invalid.");

    const primaryRoleName = primaryRoleRecord.name;
    const profileCategory = getProfileCategory(primaryRoleName);

    // ── Guard: unique email ─────────────────────────────────────────────────
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

    const passwordHash = await hashPassword(data.password);

    // ── Insert school_users row (includes new guardian/parent name fields) ──
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
        gender: (data.gender as any) || "",
        addressLineOne: data.addressLineOne || "",
        addressLineTwo: data.addressLineTwo || "",
        city: data.city || "",
        state: data.state || "",
        postalCode: data.postalCode || "",
        bloodGroup: data.bloodGroup || "",
        avatarUrl: data.avatarUrl || "",

        // ── NEW: Guardian/parent names ──────────────────────────────────────
        fatherName: data.fatherName || "",
        motherName: data.motherName || "",
        guardianName: data.guardianName || "",
        guardianRelation: data.guardianRelation || "",

        tokenVersion: 0,
      })
      .returning();

    // ── Assign roles ────────────────────────────────────────────────────────
    await tx
      .insert(schoolUserRolesSchema)
      .values(data.roleIds.map((roleId) => ({ userId: newUser.id, roleId })));

    // ── Create profile row ──────────────────────────────────────────────────
    await createUserProfile(
      tx,
      newUser.id,
      profileCategory,
      primaryRoleName,
      data
    );

    // ── Welcome email ───────────────────────────────────────────────────────
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

          <p style="margin: 24px 0;">
            <a href="${getFrontendUrlForUsers(env)}/school/auth/login" 
              style="background:#1e40af;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">
              Login to Your Account
            </a>
          </p>

          <p style="color: #dc2626;"><strong>Important:</strong> Please change your password after your first login.</p>
        </div>
      `,
    };
    await sendTransactionalEmail(env, emailData).catch((err) => {
      console.error("Welcome email failed (non-fatal):", err);
    });

    return {
      user: { ...newUser, roles: validRoles, primaryRole: primaryRoleName },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE USER
// ─────────────────────────────────────────────────────────────────────────────

export async function updateSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: UpdateUserData,
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
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

    if (!existingUser) throw new Error("User not found.");

    // ── Guard: email uniqueness ─────────────────────────────────────────────
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
      if (emailTaken) throw new Error("This email address is already in use.");
    }

    // ── Build school_users update payload ───────────────────────────────────
    const updateData: any = { updatedAt: sql`CURRENT_TIMESTAMP` };

    // Core
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    // Contact
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.alternatePhone !== undefined)
      updateData.alternatePhone = data.alternatePhone;

    // Personal
    if (data.dateOfBirth !== undefined)
      updateData.dateOfBirth = data.dateOfBirth;
    if (data.gender !== undefined) updateData.gender = data.gender;
    if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
    if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;

    // Address
    if (data.addressLineOne !== undefined)
      updateData.addressLineOne = data.addressLineOne;
    if (data.addressLineTwo !== undefined)
      updateData.addressLineTwo = data.addressLineTwo;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.postalCode !== undefined) updateData.postalCode = data.postalCode;

    // ── NEW: Guardian/parent name fields ─────────────────────────────────────
    if (data.fatherName !== undefined) updateData.fatherName = data.fatherName;
    if (data.motherName !== undefined) updateData.motherName = data.motherName;
    if (data.guardianName !== undefined)
      updateData.guardianName = data.guardianName;
    if (data.guardianRelation !== undefined)
      updateData.guardianRelation = data.guardianRelation;

    // Password change — bump tokenVersion to invalidate all active sessions
    if (data.newPassword) {
      updateData.passwordHash = await hashPassword(data.newPassword);
      updateData.tokenVersion = existingUser.tokenVersion + 1;
    }

    await tx
      .update(schoolUsersSchema)
      .set(updateData)
      .where(eq(schoolUsersSchema.id, id));

    // ── Update profile table ────────────────────────────────────────────────
    const profileCategory = getProfileCategory(existingUser.primaryRole);
    await updateUserProfile(tx, id, profileCategory, data);

    // ── Password-change notification email ──────────────────────────────────
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

/**
 * Uploads (or replaces) a user's profile photo.
 *
 * Single-photo invariant: a user has at most ONE avatar at a time. If an
 * avatar already exists, the OLD R2 object is deleted only AFTER the new
 * one uploads successfully — this ordering means a failed upload never
 * leaves the user without their previous photo.
 *
 * `bytes` is expected to already be compressed/resized client-side (≤ ~50KB,
 * WebP) per the same convention as school_feed_posts image uploads — this
 * function does not re-compress; it trusts the frontend contract.
 */
export async function uploadSchoolUserAvatar(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  bytes: ArrayBuffer,
  contentType: string
): Promise<{ avatarUrl: string }> {
  const db = await getSchoolDB(env, schoolCode);

  const user = await db
    .select({
      id: schoolUsersSchema.id,
      schoolId: schoolUsersSchema.schoolId,
      avatarKey: schoolUsersSchema.avatarKey,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found");

  // Basic server-side size guard — defense in depth even though the
  // frontend is expected to compress before sending. 100KB ceiling gives
  // headroom above the ~50KB target without allowing abuse.
  const MAX_AVATAR_BYTES = 100 * 1024;
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new Error(
      `Image is too large (${Math.round(bytes.byteLength / 1024)}KB). Please use a smaller image.`
    );
  }

  const { url, key } = await uploadUserAvatar(env, {
    schoolId: user.schoolId,
    userId: user.id,
    bytes,
    contentType,
  });

  const previousKey = user.avatarKey;

  await db
    .update(schoolUsersSchema)
    .set({
      avatarUrl: url,
      avatarKey: key,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolUsersSchema.id, userId));

  // Clean up the OLD object only after the new one is confirmed saved.
  if (previousKey && previousKey !== key) {
    await deleteUserAvatar(env, previousKey);
  }

  return { avatarUrl: url };
}

/**
 * Removes a user's profile photo entirely (back to no-avatar state).
 */
export async function removeSchoolUserAvatar(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
): Promise<void> {
  const db = await getSchoolDB(env, schoolCode);

  const user = await db
    .select({ avatarKey: schoolUsersSchema.avatarKey })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found");

  await db
    .update(schoolUsersSchema)
    .set({
      avatarUrl: "",
      avatarKey: "",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolUsersSchema.id, userId));

  if (user.avatarKey) {
    await deleteUserAvatar(env, user.avatarKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGN ROLES TO USER
// ─────────────────────────────────────────────────────────────────────────────

export async function assignRolesToUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  roleIds: number[],
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
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
    if (!user) throw new Error("User not found.");

    const validRoles = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(inArray(schoolRolesSchema.id, roleIds))
      .all();
    if (validRoles.length !== roleIds.length)
      throw new Error("One or more invalid role IDs provided.");

    // ── Guard: primary role cannot be removed ───────────────────────────────
    const primaryRoleRecord = await tx
      .select({ id: schoolRolesSchema.id, name: schoolRolesSchema.name })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.name, user.primaryRole))
      .get();
    if (!primaryRoleRecord)
      throw new Error(
        `Integrity error: primary role "${user.primaryRole}" no longer exists in the roles table. Please contact support.`
      );
    if (!roleIds.includes(primaryRoleRecord.id))
      throw new Error(
        `Cannot remove the primary role "${user.primaryRole.replace(
          /_/g,
          " "
        )}" from this user. The primary role is permanent and defines the user's identity in this school. If this user's role needs to fundamentally change, please create a new account.`
      );

    // ── Guard: last SCHOOL_OWNER ────────────────────────────────────────────
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
        if (!incomingHasOwner)
          throw new Error(
            "Cannot remove the School Owner role from the last active school owner. Please assign another user as School Owner first."
          );
      }
    }

    // ── Swap roles ──────────────────────────────────────────────────────────
    await tx
      .delete(schoolUserRolesSchema)
      .where(eq(schoolUserRolesSchema.userId, userId));
    await tx
      .insert(schoolUserRolesSchema)
      .values(roleIds.map((roleId) => ({ userId, roleId })));

    // Bump tokenVersion to invalidate all current sessions
    const newTokenVersion = user.tokenVersion + 1;
    await tx
      .update(schoolUsersSchema)
      .set({ tokenVersion: newTokenVersion })
      .where(eq(schoolUsersSchema.id, userId));

    const newPermissions = await getUserPermissionsFromDB(tx, userId);
    console.log(
      `🔄 Role update for user ${userId} | primaryRole: ${
        user.primaryRole
      } | new roles: ${validRoles
        .map((r) => r.name)
        .join(", ")} | permissions: ${newPermissions.length}`
    );

    // ── Role-update notification email ──────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// GET USER ROLES
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// GET USER DIRECT PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// GET USER DENIED PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function getUserDeniedPermissions(
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
    .from(schoolUserPermissionDenialsSchema)
    .innerJoin(
      schoolPermissionsSchema,
      eq(
        schoolUserPermissionDenialsSchema.permissionId,
        schoolPermissionsSchema.id
      )
    )
    .where(eq(schoolUserPermissionDenialsSchema.userId, userId))
    .all();
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGN DIRECT PERMISSIONS + DENIALS
// ─────────────────────────────────────────────────────────────────────────────

export async function assignDirectPermissionsToUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  permissionIds: number[],
  deniedPermissionIds: number[],
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const user = await tx
      .select({
        id: schoolUsersSchema.id,
        tokenVersion: schoolUsersSchema.tokenVersion,
        primaryRole: schoolUsersSchema.primaryRole,
      })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, userId))
      .get();
    if (!user) throw new Error("User not found");

    const profileCat = getProfileCategory(user.primaryRole);
    const expectedCategory = profileCategoryToPermissionCategory(profileCat);
    const allIds = [...new Set([...permissionIds, ...deniedPermissionIds])];

    if (allIds.length > 0) {
      const perms = await tx
        .select({
          id: schoolPermissionsSchema.id,
          slug: schoolPermissionsSchema.slug,
          category: schoolPermissionsSchema.category,
        })
        .from(schoolPermissionsSchema)
        .where(inArray(schoolPermissionsSchema.id, allIds))
        .all();
      if (perms.length !== allIds.length)
        throw new Error("One or more invalid permission IDs");

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
          `Category mismatch: The following permissions do not belong to the "${CATEGORY_LABELS[expectedCategory]}" category: ${slugList}. Only ${CATEGORY_LABELS[expectedCategory]} permissions can be assigned to this user (their primary role is "${user.primaryRole}").`
        );
      }
    }

    // ── Replace grants ──────────────────────────────────────────────────────
    await tx
      .delete(schoolUserPermissionsSchema)
      .where(eq(schoolUserPermissionsSchema.userId, userId));
    if (permissionIds.length > 0) {
      await tx
        .insert(schoolUserPermissionsSchema)
        .values(
          permissionIds.map((permissionId) => ({ userId, permissionId }))
        );
    }

    // ── Replace denials ─────────────────────────────────────────────────────
    await tx
      .delete(schoolUserPermissionDenialsSchema)
      .where(eq(schoolUserPermissionDenialsSchema.userId, userId));
    if (deniedPermissionIds.length > 0) {
      await tx
        .insert(schoolUserPermissionDenialsSchema)
        .values(
          deniedPermissionIds.map((permissionId) => ({ userId, permissionId }))
        );
    }

    // Bump tokenVersion so the next token refresh picks up new permissions
    await tx
      .update(schoolUsersSchema)
      .set({ tokenVersion: user.tokenVersion + 1 })
      .where(eq(schoolUsersSchema.id, userId));

    console.log(
      `🔄 Updated permissions for user ${userId} (primaryRole: ${user.primaryRole}, category: ${expectedCategory}, grants: ${permissionIds.length}, denials: ${deniedPermissionIds.length})`
    );

    return { message: "Permissions updated successfully" };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE USER
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteSchoolUser(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

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

  if (activeEnrollment)
    throw new Error(
      "Cannot delete a student with active enrollments. Please unenroll the student first, or deactivate the account instead."
    );

  await db.delete(schoolUsersSchema).where(eq(schoolUsersSchema.id, id));
  return { message: "User deleted successfully" };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

        // ── School-internal ─────────────────────────────────────────────────
        admissionNumber: data.admissionNumber || null,
        rollNumber: data.rollNumber || "",
        admissionDate: data.admissionDate || "",
        previousSchool: data.previousSchool || "",
        medicalInfo: data.medicalInfo || "",
        enrollmentType: data.enrollmentType || "REGULAR",

        // ── UDISE / National identity ───────────────────────────────────────
        pen: data.pen || null,
        apaarId: data.apaarId || null,
        stateStudentId: data.stateStudentId || null,
        aadhaarMasked: data.aadhaarMasked || null,
        aadhaarName: data.aadhaarName || null,
        previousSchoolUdiseCode: data.previousSchoolUdiseCode || null,

        // ── UDISE+ demographic ──────────────────────────────────────────────
        previousClassResult: data.previousClassResult || null,
        socialCategory: data.socialCategory ?? null,
        religion: data.religion ?? null,
        isMinority: data.isMinority ?? false,
        motherTongueCode: data.motherTongueCode ?? null,

        // ── Socio-economic ──────────────────────────────────────────────────
        isBpl: data.isBpl ?? false,
        localityType: data.localityType || null,

        // ── CWSN ───────────────────────────────────────────────────────────
        isCwsn: data.isCwsn ?? false,
        disabilityType: data.disabilityType ?? null,
        hasDisabilityCertificate: data.hasDisabilityCertificate ?? false,
        udidNumber: data.udidNumber || null,

        // ── Facilities ─────────────────────────────────────────────────────
        facilitiesReceived: JSON.stringify(data.facilitiesReceived ?? []),

        // ── Verification flags ──────────────────────────────────────────────
        isAadhaarVerified: data.isAadhaarVerified ?? false,
        udiseVerified: data.udiseVerified ?? false,
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
    case "student": {
      // ── School-internal ───────────────────────────────────────────────────
      if (data.admissionNumber !== undefined)
        updateData.admissionNumber = data.admissionNumber || null;
      if (data.rollNumber !== undefined)
        updateData.rollNumber = data.rollNumber;
      if (data.admissionDate !== undefined)
        updateData.admissionDate = data.admissionDate;
      if (data.previousSchool !== undefined)
        updateData.previousSchool = data.previousSchool;
      if (data.medicalInfo !== undefined)
        updateData.medicalInfo = data.medicalInfo;
      if (data.enrollmentType !== undefined)
        updateData.enrollmentType = data.enrollmentType;

      // ── UDISE / National identity ─────────────────────────────────────────
      if (data.pen !== undefined) updateData.pen = data.pen || null;
      if (data.apaarId !== undefined) updateData.apaarId = data.apaarId || null;
      if (data.stateStudentId !== undefined)
        updateData.stateStudentId = data.stateStudentId || null;
      if (data.aadhaarMasked !== undefined)
        updateData.aadhaarMasked = data.aadhaarMasked || null;
      if (data.aadhaarName !== undefined)
        updateData.aadhaarName = data.aadhaarName || null;
      if (data.previousSchoolUdiseCode !== undefined)
        updateData.previousSchoolUdiseCode =
          data.previousSchoolUdiseCode || null;

      // ── UDISE+ demographic ────────────────────────────────────────────────
      if (data.previousClassResult !== undefined)
        updateData.previousClassResult = data.previousClassResult;
      if (data.socialCategory !== undefined)
        updateData.socialCategory = data.socialCategory;
      if (data.religion !== undefined) updateData.religion = data.religion;
      if (data.isMinority !== undefined)
        updateData.isMinority = data.isMinority;
      if (data.motherTongueCode !== undefined)
        updateData.motherTongueCode = data.motherTongueCode;

      // ── Socio-economic ────────────────────────────────────────────────────
      if (data.isBpl !== undefined) updateData.isBpl = data.isBpl;
      if (data.localityType !== undefined)
        updateData.localityType = data.localityType;

      // ── CWSN ──────────────────────────────────────────────────────────────
      if (data.isCwsn !== undefined) updateData.isCwsn = data.isCwsn;
      if (data.disabilityType !== undefined)
        updateData.disabilityType = data.disabilityType;
      if (data.hasDisabilityCertificate !== undefined)
        updateData.hasDisabilityCertificate = data.hasDisabilityCertificate;
      if (data.udidNumber !== undefined)
        updateData.udidNumber = data.udidNumber || null;

      // ── Facilities (serialise array → JSON string) ────────────────────────
      if (data.facilitiesReceived !== undefined)
        updateData.facilitiesReceived = JSON.stringify(data.facilitiesReceived);

      // ── Verification flags ────────────────────────────────────────────────
      if (data.isAadhaarVerified !== undefined)
        updateData.isAadhaarVerified = data.isAadhaarVerified;
      if (data.udiseVerified !== undefined)
        updateData.udiseVerified = data.udiseVerified;

      if (Object.keys(updateData).length > 0) {
        await tx
          .update(studentsSchema)
          .set(updateData)
          .where(eq(studentsSchema.userId, userId));
      }
      break;
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// BULK PHOTO UPLOAD (class-section based)
// ─────────────────────────────────────────────────────────────────────────────

export interface StudentForAvatarUpload {
  userId: number;
  name: string;
  avatarUrl: string | null;
  rollNumber: string | null;
  admissionNumber: string | null;
  gender: string | null;
  enrollmentId: number;

  fatherName: string | null;
  motherName: string | null;
  phone: string | null;
}

/**
 * Lists active students in a class-section for the bulk photo upload tool.
 * Deliberately lean — the caller already knows which class-section this is
 * (it just picked it from the dropdown), so we don't join class/section names.
 *
 * NOTE on ordering: rollNumber is free-text (not always zero-padded), so
 * "10" can sort before "2" lexically. If your school always zero-pads roll
 * numbers this is a non-issue; otherwise consider ORDER BY CAST(roll_number
 * AS INTEGER) via raw sql if this bites you in practice.
 */
export async function getStudentsByClassSectionForAvatarUpload(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
): Promise<StudentForAvatarUpload[]> {
  const db = await getSchoolDB(env, schoolCode);

  const rows = await db
    .select({
      userId: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      avatarUrl: schoolUsersSchema.avatarUrl,
      fatherName: schoolUsersSchema.fatherName,
      motherName: schoolUsersSchema.motherName,
      phone: schoolUsersSchema.phone,
      gender: schoolUsersSchema.gender,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      admissionNumber: studentsSchema.admissionNumber,
      enrollmentId: schoolStudentEnrollmentsSchema.id,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolUsersSchema.id, schoolStudentEnrollmentsSchema.studentId)
    )
    .innerJoin(
      studentsSchema,
      eq(studentsSchema.userId, schoolStudentEnrollmentsSchema.studentId)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true),
        eq(schoolUsersSchema.isActive, true)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name)
    .all();

  return rows.map((r: any) => ({
    userId: r.userId,
    name: r.name,
    avatarUrl: r.avatarUrl || null,
    gender: r.gender || null,
    fatherName: r.fatherName || null,
    motherName: r.motherName || null,
    phone: r.phone || null,
    rollNumber: r.rollNumber ?? null,
    admissionNumber: r.admissionNumber ?? null,
    enrollmentId: r.enrollmentId,
  }));
}

export interface BulkAvatarUploadItem {
  userId: number;
  bytes: ArrayBuffer;
  contentType: string;
}

export interface BulkAvatarUploadOutcome {
  uploaded: { userId: number; avatarUrl: string }[];
  failed: { userId: number; error: string }[];
}

/**
 * Uploads photos for multiple students in one call, reusing the exact same
 * single-avatar pipeline (uploadSchoolUserAvatar) per student — same R2 key
 * shape, same old-key cleanup, same size guard.
 *
 * Runs with bounded concurrency (not sequential, not unbounded Promise.all)
 * — a class-section can have 40-60 students, and R2 round-trips add up.
 * 5 concurrent uploads keeps this fast without hammering the DB connection
 * or R2 with 60 simultaneous PUTs.
 *
 * Partial failure is expected and handled gracefully — one bad file
 * shouldn't fail the other 39. Per-item errors are collected and returned
 * so the frontend can show exactly which students need a retry.
 */
export async function bulkUploadStudentAvatars(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  items: BulkAvatarUploadItem[]
): Promise<BulkAvatarUploadOutcome> {
  const db = await getSchoolDB(env, schoolCode);

  // Defense in depth: route-level Zod validates shape, this confirms every
  // userId is actually a student row in THIS school before we touch R2.
  const ids = items.map((i) => i.userId);
  const validStudents = await db
    .select({ userId: studentsSchema.userId })
    .from(studentsSchema)
    .where(inArray(studentsSchema.userId, ids))
    .all();
  const validIdSet = new Set(validStudents.map((s: any) => s.userId));

  const uploaded: { userId: number; avatarUrl: string }[] = [];
  const failed: { userId: number; error: string }[] = [];

  const CONCURRENCY = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];

      if (!validIdSet.has(item.userId)) {
        failed.push({
          userId: item.userId,
          error: "Not a valid student in this school",
        });
        continue;
      }

      try {
        const result = await uploadSchoolUserAvatar(
          env,
          schoolCode,
          item.userId,
          item.bytes,
          item.contentType
        );
        uploaded.push({ userId: item.userId, avatarUrl: result.avatarUrl });
      } catch (err: any) {
        failed.push({
          userId: item.userId,
          error: err?.message || "Upload failed",
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker())
  );

  return { uploaded, failed };
}