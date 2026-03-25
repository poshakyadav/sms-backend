import { getSchoolDB } from "../../../db/school-client";
import { and, eq } from "drizzle-orm";
import {
  schoolSubjectsSchema,
  schoolTeacherAssignmentsSchema,
  schoolClassesSchema,
  schoolUsersSchema,
  teachersSchema,
  schoolClassSectionSubjectsSchema,
  schoolSectionsSchema,
  schoolClassSectionsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

// ==================== Create Subject ====================
export async function createSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [newSubject] = await db
    .insert(schoolSubjectsSchema)
    .values(data)
    .returning();

  return { subject: newSubject, message: "Subject created successfully" };
}

// ==================== Get Subjects ====================
export async function getSubjects(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select()
    .from(schoolSubjectsSchema)
    .orderBy(schoolSubjectsSchema.name);
}

// ==================== Update Subject ====================
export async function updateSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolSubjectsSchema)
    .set(data)
    .where(eq(schoolSubjectsSchema.id, id))
    .returning();

  if (!updated) throw new Error("Subject not found");

  return { subject: updated, message: "Subject updated successfully" };
}

// ==================== Delete Subject ====================
export async function deleteSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const used = await db
    .select()
    .from(schoolClassSectionSubjectsSchema)
    .where(eq(schoolClassSectionSubjectsSchema.subjectId, id))
    .limit(1)
    .get();

  if (used) throw new Error("Cannot delete subject assigned to classes");

  const [deleted] = await db
    .delete(schoolSubjectsSchema)
    .where(eq(schoolSubjectsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Subject not found");

  return { message: "Subject deleted successfully" };
}

// ==================== Assign Subject to Class (with duplicate guard) ====================
export async function assignSubjectToClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  // Prevent duplicate
  const existing = await db
    .select()
    .from(schoolClassSectionSubjectsSchema)
    .where(
      and(
        eq(
          schoolClassSectionSubjectsSchema.classSectionId,
          data.classSectionId
        ),
        eq(schoolClassSectionSubjectsSchema.subjectId, data.subjectId)
      )
    )
    .get();

  if (existing)
    throw new Error("This subject is already assigned to the class-section");

  const [newAssignment] = await db
    .insert(schoolClassSectionSubjectsSchema)
    .values(data)
    .returning();

  return { assignment: newAssignment, message: "Subject assigned to class" };
}

// ==================== Get Subjects for a Specific Class-Section ====================
export async function getClassSectionSubjects(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionSubjectsSchema.id,
      subjectId: schoolClassSectionSubjectsSchema.subjectId,
      subjectName: schoolSubjectsSchema.name,
      subjectCode: schoolSubjectsSchema.code,
      isMandatory: schoolClassSectionSubjectsSchema.isMandatory,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolClassSectionSubjectsSchema)
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
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
    .where(eq(schoolClassSectionSubjectsSchema.classSectionId, classSectionId))
    .orderBy(schoolSubjectsSchema.name);
}

// ==================== Get Single Class Subject by ID (NEW for header name) ====================
export async function getClassSubjectById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSubjectId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const result = await db
    .select({
      id: schoolClassSectionSubjectsSchema.id,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isMandatory: schoolClassSectionSubjectsSchema.isMandatory,
    })
    .from(schoolClassSectionSubjectsSchema)
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
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
    .where(eq(schoolClassSectionSubjectsSchema.id, classSubjectId))
    .get();

  if (!result) throw new Error("Class subject not found");
  return result;
}

// ==================== Get All Class-Subjects (NEW for select) ====================
export async function getAllClassSubjects(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionSubjectsSchema.id,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isMandatory: schoolClassSectionSubjectsSchema.isMandatory,
    })
    .from(schoolClassSectionSubjectsSchema)
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
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
    .orderBy(
      schoolClassesSchema.sort_order,
      schoolSectionsSchema.name,
      schoolSubjectsSchema.name
    );
}

// ==================== Assign Teacher to Subject ====================
export async function assignTeacherToSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);
  const [newAssignment] = await db
    .insert(schoolTeacherAssignmentsSchema)
    .values(data)
    .returning();
  return {
    assignment: newAssignment,
    message: "Teacher assigned successfully",
  };
}

// ==================== Get All Teachers ====================
export async function getTeachers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);
  return await db
    .select({
      id: teachersSchema.userId, // Use userId as teacher ID
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      qualification: teachersSchema.qualification,
      experienceYears: teachersSchema.experienceYears,
      specialization: teachersSchema.specialization,
    })
    .from(teachersSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(teachersSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(schoolUsersSchema.role, SchoolRole.TEACHER)) // Filter by role
    .orderBy(schoolUsersSchema.name);
}

// ==================== Get Teachers for Class-Subject (NEW) ====================
export async function getClassSubjectTeachers(env: SchoolEnv["Bindings"], schoolCode: string, classSubjectId: number) {
  const db = await getSchoolDB(env, schoolCode);
  return await db
    .select({
      id: schoolTeacherAssignmentsSchema.id,
      classSubjectId: schoolTeacherAssignmentsSchema.classSubjectId,
      teacherId: schoolTeacherAssignmentsSchema.teacherId,
      teacherName: schoolUsersSchema.name,
      teacherEmail: schoolUsersSchema.email,
      isPrimary: schoolTeacherAssignmentsSchema.isPrimary,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolTeacherAssignmentsSchema)
    .innerJoin(schoolUsersSchema, eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id))
    .innerJoin(schoolClassSectionSubjectsSchema, eq(schoolTeacherAssignmentsSchema.classSubjectId, schoolClassSectionSubjectsSchema.id))
    .innerJoin(schoolSubjectsSchema, eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id))
    .innerJoin(schoolClassSectionsSchema, eq(schoolClassSectionSubjectsSchema.classSectionId, schoolClassSectionsSchema.id))
    .innerJoin(schoolClassesSchema, eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id))
    .innerJoin(schoolSectionsSchema, eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id))
    .where(eq(schoolTeacherAssignmentsSchema.classSubjectId, classSubjectId))
    .orderBy(schoolUsersSchema.name);
}

// ==================== Get Teacher Assignments ====================
export async function getTeacherAssignments(env: SchoolEnv["Bindings"], schoolCode: string, teacherId: number) {
  const db = await getSchoolDB(env, schoolCode);
  return await db
    .select({
      id: schoolTeacherAssignmentsSchema.id,
      classSubjectId: schoolTeacherAssignmentsSchema.classSubjectId,
      teacherId: schoolTeacherAssignmentsSchema.teacherId,
      teacherName: schoolUsersSchema.name,
      isPrimary: schoolTeacherAssignmentsSchema.isPrimary,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolTeacherAssignmentsSchema)
    .innerJoin(schoolUsersSchema, eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id))
    .innerJoin(schoolClassSectionSubjectsSchema, eq(schoolTeacherAssignmentsSchema.classSubjectId, schoolClassSectionSubjectsSchema.id))
    .innerJoin(schoolSubjectsSchema, eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id))
    .innerJoin(schoolClassSectionsSchema, eq(schoolClassSectionSubjectsSchema.classSectionId, schoolClassSectionsSchema.id))
    .innerJoin(schoolClassesSchema, eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id))
    .innerJoin(schoolSectionsSchema, eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id))
    .where(eq(schoolTeacherAssignmentsSchema.teacherId, teacherId));
}

// ==================== Unassign Teacher from Subject (NEW) ====================
export async function unassignTeacherFromSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  assignmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);
  const [deleted] = await db
    .delete(schoolTeacherAssignmentsSchema)
    .where(eq(schoolTeacherAssignmentsSchema.id, assignmentId))
    .returning();
  if (!deleted) throw new Error("Teacher assignment not found");
  return { message: "Teacher unassigned successfully" };
}

// ==================== Unassign Subject from Class (NEW) ====================
export async function unassignSubjectFromClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSubjectId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const [deleted] = await db
    .delete(schoolClassSectionSubjectsSchema)
    .where(eq(schoolClassSectionSubjectsSchema.id, classSubjectId))
    .returning();

  if (!deleted) throw new Error("Class subject assignment not found");

  return { message: "Subject unassigned successfully" };
}
