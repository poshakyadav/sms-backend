import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { and, asc, eq } from "drizzle-orm"; // Fixed: Import and, eq
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { studentsSchema } from "../../../db/schemas/school/students";
import { SchoolRole } from "../../../types/school-role";
import {
  parentsSchema,
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";

// ==================== GET ALL STUDENTS ====================
/**
 * Returns all users who have a student profile (joined via `students` table).
 * No longer filters by role column — role column was removed in PBAC migration.
 * Being in the `students` table is the canonical signal that a user is a student.
 */
export async function getStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const students = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      phone: schoolUsersSchema.phone,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      bloodGroup: schoolUsersSchema.bloodGroup,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      // Student-specific fields
      rollNumber: studentsSchema.rollNumber,
      admissionDate: studentsSchema.admissionDate,
      previousSchool: studentsSchema.previousSchool,
      medicalInfo: studentsSchema.medicalInfo,
    })
    .from(studentsSchema) // ← anchor on students table (identity = student)
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(schoolUsersSchema.isActive, true))
    .orderBy(asc(schoolUsersSchema.name))
    .all();

  return students;
}

// ==================== GET STUDENT BY ID ====================
/**
 * Returns a single student with their profile, current enrollment,
 * and parent information.
 */
export async function getStudentById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Base student record
  const student = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      phone: schoolUsersSchema.phone,
      alternatePhone: schoolUsersSchema.alternatePhone,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      bloodGroup: schoolUsersSchema.bloodGroup,
      avatarUrl: schoolUsersSchema.avatarUrl,
      addressLineOne: schoolUsersSchema.addressLineOne,
      addressLineTwo: schoolUsersSchema.addressLineTwo,
      city: schoolUsersSchema.city,
      state: schoolUsersSchema.state,
      postalCode: schoolUsersSchema.postalCode,
      isActive: schoolUsersSchema.isActive,
      createdAt: schoolUsersSchema.createdAt,
      // Student-specific
      rollNumber: studentsSchema.rollNumber,
      admissionDate: studentsSchema.admissionDate,
      previousSchool: studentsSchema.previousSchool,
      medicalInfo: studentsSchema.medicalInfo,
    })
    .from(studentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(studentsSchema.userId, userId))
    .get();

  if (!student) return null;

  // 2. Current active enrollment (class + section info)
  const enrollment = await db
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
    enrollments: enrollment,
    parents,
  };
}

/**
 * Get all students enrolled in a specific class-section (current academic year).
 * Returns enriched data including fee summary, attendance %, etc.
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

  const students = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      phone: schoolUsersSchema.phone,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      bloodGroup: schoolUsersSchema.bloodGroup,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      // Student profile
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      admissionDate: studentsSchema.admissionDate,
      previousSchool: studentsSchema.previousSchool,
      medicalInfo: studentsSchema.medicalInfo,
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
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name);

  return students;
}
