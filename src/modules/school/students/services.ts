import { and, asc, eq } from "drizzle-orm"; // Fixed: Import and, eq
import {
  parentsSchema,
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { studentsSchema } from "../../../db/schemas/school/students";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

// ── Helper ────────────────────────────────────────────────────────────────────
function parseFacilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── COMPLETE student fields selector (school_users + students join) ────────────
// Used in every SELECT that needs the full student data set.
const STUDENT_CORE_FIELDS = {
  // school_users — identity
  id: schoolUsersSchema.id,
  name: schoolUsersSchema.name,
  email: schoolUsersSchema.email,
  phone: schoolUsersSchema.phone,
  alternatePhone: schoolUsersSchema.alternatePhone,
  gender: schoolUsersSchema.gender,
  dateOfBirth: schoolUsersSchema.dateOfBirth,
  bloodGroup: schoolUsersSchema.bloodGroup,
  avatarUrl: schoolUsersSchema.avatarUrl,
  isActive: schoolUsersSchema.isActive,
  // school_users — address
  addressLineOne: schoolUsersSchema.addressLineOne,
  addressLineTwo: schoolUsersSchema.addressLineTwo,
  city: schoolUsersSchema.city,
  state: schoolUsersSchema.state,
  postalCode: schoolUsersSchema.postalCode,
  // school_users — parental/guardian
  fatherName: schoolUsersSchema.fatherName,
  motherName: schoolUsersSchema.motherName,
  guardianName: schoolUsersSchema.guardianName,
  guardianRelation: schoolUsersSchema.guardianRelation,
  // students — school-internal
  admissionNumber: studentsSchema.admissionNumber,
  admissionDate: studentsSchema.admissionDate,
  rollNumber: studentsSchema.rollNumber,
  enrollmentType: studentsSchema.enrollmentType,
  previousSchool: studentsSchema.previousSchool,
  previousSchoolUdiseCode: studentsSchema.previousSchoolUdiseCode,
  previousClassResult: studentsSchema.previousClassResult,
  medicalInfo: studentsSchema.medicalInfo,
  // students — UDISE / National identity
  pen: studentsSchema.pen,
  apaarId: studentsSchema.apaarId,
  stateStudentId: studentsSchema.stateStudentId,
  aadhaarMasked: studentsSchema.aadhaarMasked,
  aadhaarName: studentsSchema.aadhaarName,
  isAadhaarVerified: studentsSchema.isAadhaarVerified,
  udiseVerified: studentsSchema.udiseVerified,
  // students — UDISE+ demographic
  socialCategory: studentsSchema.socialCategory,
  religion: studentsSchema.religion,
  isMinority: studentsSchema.isMinority,
  motherTongueCode: studentsSchema.motherTongueCode,
  // students — Socio-economic
  isBpl: studentsSchema.isBpl,
  localityType: studentsSchema.localityType,
  // students — CWSN
  isCwsn: studentsSchema.isCwsn,
  disabilityType: studentsSchema.disabilityType,
  hasDisabilityCertificate: studentsSchema.hasDisabilityCertificate,
  udidNumber: studentsSchema.udidNumber,
  // students — Facilities
  facilitiesReceived: studentsSchema.facilitiesReceived,
};

// ==================== GET ALL STUDENTS ====================
/**
 * Returns all users who have a student profile (joined via `students` table).
 * Includes all UDISE+ fields and guardian/parental fields from school_users.
 */
export async function getStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const rows = await db
    .select(STUDENT_CORE_FIELDS)
    .from(studentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(schoolUsersSchema.isActive, true))
    .orderBy(asc(schoolUsersSchema.name))
    .all();

  return rows.map((row) => ({
    ...row,
    facilitiesReceived: parseFacilities(
      row.facilitiesReceived as string | null
    ),
  }));
}

// ==================== GET STUDENT BY ID ====================
/**
 * Returns a single student with full profile (all UDISE+ fields),
 * current enrollment(s), and parent information.
 */
export async function getStudentById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Base student record — full UDISE fields
  const student = await db
    .select({
      ...STUDENT_CORE_FIELDS,
      createdAt: schoolUsersSchema.createdAt,
    })
    .from(studentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(studentsSchema.userId, userId))
    .get();

  if (!student) return null;

  // 2. All enrollments (class + section info) — not just active
  const enrollments = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
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
    .where(eq(schoolStudentEnrollmentsSchema.studentId, userId))
    .all();

  // 3. Parents linked to this student
  const parents = await db
    .select({
      parentId: parentsSchema.userId,
      parentName: schoolUsersSchema.name,
      parentEmail: schoolUsersSchema.email,
      parentPhone: schoolUsersSchema.phone,
      relationship: studentParentsSchema.relationship,
      isPrimary: studentParentsSchema.isPrimary,
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
    .where(eq(studentParentsSchema.studentId, userId))
    .all();

  return {
    ...student,
    facilitiesReceived: parseFacilities(
      student.facilitiesReceived as string | null
    ),
    enrollments,
    parents,
  };
}

// ==================== GET STUDENTS BY CLASS-SECTION ====================
/**
 * Get all students enrolled in a specific class-section (current academic year).
 * Now returns the full UDISE+ field set along with enrollment details.
 */
export async function getStudentsByClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Get current academic year
  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No current academic year found");

  const rows = await db
    .select({
      // All core student fields
      ...STUDENT_CORE_FIELDS,
      // Override rollNumber with the enrollment-level roll number
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      // Enrollment details
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
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
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name)
    .all();

  return rows.map((row) => ({
    ...row,
    facilitiesReceived: parseFacilities(
      row.facilitiesReceived as string | null
    ),
  }));
}
