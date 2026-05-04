import { and, eq } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolClassSectionSubjectsSchema,
  schoolSectionsSchema,
  schoolSubjectsSchema,
  schoolTeacherAssignmentsSchema,
  schoolUsersSchema,
  teachersSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

// ==================== CREATE SUBJECT ====================
export async function createSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { name: string; code?: string; description?: string }
) {
  const db = await getSchoolDB(env, schoolCode);

  const [newSubject] = await db
    .insert(schoolSubjectsSchema)
    .values(data)
    .returning();

  return { subject: newSubject, message: "Subject created successfully" };
}

// ==================== GET SUBJECTS ====================
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

// ==================== UPDATE SUBJECT ====================
export async function updateSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: Partial<{ name: string; code: string; description: string }>
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

// ==================== DELETE SUBJECT ====================
export async function deleteSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const used = await db
    .select({ id: schoolClassSectionSubjectsSchema.id })
    .from(schoolClassSectionSubjectsSchema)
    .where(eq(schoolClassSectionSubjectsSchema.subjectId, id))
    .limit(1)
    .get();

  if (used)
    throw new Error(
      "Cannot delete subject — it is assigned to one or more classes"
    );

  const [deleted] = await db
    .delete(schoolSubjectsSchema)
    .where(eq(schoolSubjectsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Subject not found");
  return { message: "Subject deleted successfully" };
}

// ==================== ASSIGN SUBJECT TO CLASS-SECTION (with duplicate guard) ====================
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

// ==================== GET SUBJECTS FOR SPECIFIC CLASS-SECTION ====================
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

// ==================== GET CLASS-SECTION SUBJECT BY ID ====================
export async function getClassSectionSubjectById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionSubjectId: number
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
    .where(eq(schoolClassSectionSubjectsSchema.id, classSectionSubjectId))
    .get();

  if (!result) throw new Error("Class subject not found");
  return result;
}

// ==================== GET ALL CLASS-SUBJECTS ====================
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
    .orderBy(
      schoolClassesSchema.sort_order,
      schoolSectionsSchema.name,
      schoolSubjectsSchema.name
    );
}

// ==================== ASSIGN TEACHER TO SUBJECT ====================
export async function assignTeacherToSubject(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { teacherId: number; classSectionSubjectId: number; isPrimary: boolean }
) {
  const db = await getSchoolDB(env, schoolCode);

  // Guard: prevent duplicate assignment
  const existing = await db
    .select({ id: schoolTeacherAssignmentsSchema.id })
    .from(schoolTeacherAssignmentsSchema)
    .where(
      and(
        eq(schoolTeacherAssignmentsSchema.teacherId, data.teacherId),
        eq(
          schoolTeacherAssignmentsSchema.classSectionSubjectId,
          data.classSectionSubjectId
        )
      )
    )
    .get();

  if (existing)
    throw new Error("Teacher is already assigned to this class-subject");

  const [newAssignment] = await db
    .insert(schoolTeacherAssignmentsSchema)
    .values({
      teacherId: data.teacherId,
      classSectionSubjectId: data.classSectionSubjectId,
      isPrimary: data.isPrimary,
    })
    .returning();

  return {
    assignment: newAssignment,
    message: "Teacher assigned successfully",
  };
}

// ==================== GET ALL TEACHERS ====================
export async function getTeachers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: teachersSchema.userId,
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
    .where(eq(schoolUsersSchema.isActive, true))
    .orderBy(schoolUsersSchema.name);
}

// ==================== GET TEACHERS FOR CLASS-SUBJECT ====================
export async function getClassSectionSubjectTeachers(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionSubjectId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolTeacherAssignmentsSchema.id,
      classSectionSubjectId:
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
      teacherId: schoolTeacherAssignmentsSchema.teacherId,
      teacherName: schoolUsersSchema.name,
      teacherEmail: schoolUsersSchema.email,
      isPrimary: schoolTeacherAssignmentsSchema.isPrimary,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolTeacherAssignmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
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
    .where(
      eq(
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
        classSectionSubjectId
      )
    )
    .orderBy(schoolUsersSchema.name);
}

// ==================== GET TEACHER ASSIGNMENTS ====================
export async function getTeacherAssignments(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  teacherId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolTeacherAssignmentsSchema.id,
      classSectionSubjectId:
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
      teacherId: schoolTeacherAssignmentsSchema.teacherId,
      teacherName: schoolUsersSchema.name,
      isPrimary: schoolTeacherAssignmentsSchema.isPrimary,
      subjectName: schoolSubjectsSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolTeacherAssignmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
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
    .where(eq(schoolTeacherAssignmentsSchema.teacherId, teacherId));
}

// ==================== UNASSIGN TEACHER ====================
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

// ==================== UNASSIGN SUBJECT FROM CLASS-SECTION ====================
export async function unassignSubjectFromClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionSubjectId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Guard: teacher assignments depend on this
  const hasAssignments = await db
    .select({ id: schoolTeacherAssignmentsSchema.id })
    .from(schoolTeacherAssignmentsSchema)
    .where(
      eq(
        schoolTeacherAssignmentsSchema.classSectionSubjectId,
        classSectionSubjectId
      )
    )
    .limit(1)
    .get();

  if (hasAssignments) {
    throw new Error(
      "Cannot unassign subject — it has teachers assigned. Remove teacher assignments first."
    );
  }

  const [deleted] = await db
    .delete(schoolClassSectionSubjectsSchema)
    .where(eq(schoolClassSectionSubjectsSchema.id, classSectionSubjectId))
    .returning();

  if (!deleted) throw new Error("Class subject assignment not found");
  return { message: "Subject unassigned successfully" };
}
