// src/modules/school/subjects/services.ts

import { and, eq } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolClassSectionSubjectsSchema,
  schoolSectionsSchema,
  SchoolSubject,
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

// ==================== BULK CREATE SUBJECTS ====================
/**
 * Bulk-create subjects in a single request.
 *
 * Strategy:
 *   1. Normalise names (trim, collapse whitespace).
 *   2. Fetch all existing subject names once (single round trip).
 *   3. Split input into "to insert" vs "skipped" (already exist).
 *   4. Insert only new subjects.
 *   5. Return created rows + list of skipped names.
 *
 * The unique constraint on `code` is enforced per-row in the insert:
 * if two rows in the same batch share a code, the second one is skipped
 * with an explanatory message in the `errors` array.
 */
export async function bulkCreateSubjects(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  subjects: Array<{ name: string; code?: string; description?: string }>
): Promise<{
  subjects: SchoolSubject[];
  skipped: string[];
  errors: string[];
  message: string;
}> {
  if (!subjects || subjects.length === 0) {
    throw new Error("No subjects provided");
  }
  if (subjects.length > 100) {
    throw new Error("Cannot create more than 100 subjects at once");
  }

  const db = await getSchoolDB(env, schoolCode);

  // 1. Normalise input — trim whitespace, build unique name map
  const normalised = subjects.map((s) => ({
    name: s.name.trim(),
    code: s.code?.trim() || undefined,
    description: s.description?.trim() || undefined,
  }));

  // 2. Fetch all existing names in one query
  const existing = await db
    .select({
      name: schoolSubjectsSchema.name,
      code: schoolSubjectsSchema.code,
    })
    .from(schoolSubjectsSchema)
    .all();

  const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
  const existingCodes = new Set(
    existing.filter((e) => e.code).map((e) => e.code!.toLowerCase())
  );

  // 3. Classify: skip duplicates, collect errors, build insert list
  const toInsert: Array<{ name: string; code?: string; description?: string }> =
    [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const seenNamesInBatch = new Set<string>();
  const seenCodesInBatch = new Set<string>();

  for (const s of normalised) {
    const nameLower = s.name.toLowerCase();
    const codeLower = s.code?.toLowerCase();

    if (!s.name) {
      errors.push(`Empty subject name skipped`);
      continue;
    }

    if (existingNames.has(nameLower) || seenNamesInBatch.has(nameLower)) {
      skipped.push(s.name);
      continue;
    }

    if (codeLower) {
      if (existingCodes.has(codeLower) || seenCodesInBatch.has(codeLower)) {
        errors.push(
          `"${s.name}" skipped — subject code "${s.code}" already exists`
        );
        continue;
      }
      seenCodesInBatch.add(codeLower);
    }

    seenNamesInBatch.add(nameLower);
    toInsert.push(s);
  }

  if (toInsert.length === 0) {
    return {
      subjects: [],
      skipped,
      errors,
      message:
        skipped.length > 0
          ? `All ${skipped.length} subject(s) already exist`
          : "Nothing to create",
    };
  }

  // 4. Insert in a single statement (Drizzle batches values internally)
  const created = await db
    .insert(schoolSubjectsSchema)
    .values(toInsert)
    .returning();

  const total = created.length;
  const skipCount = skipped.length;
  const errCount = errors.length;

  let message = `${total} subject(s) created successfully`;
  if (skipCount > 0) message += `, ${skipCount} skipped (already exist)`;
  if (errCount > 0) message += `, ${errCount} error(s)`;

  return { subjects: created, skipped, errors, message };
}

// ==================== BULK UPDATE SUBJECTS ====================
/**
 * Bulk-update subjects in a single request.
 *
 * Each item MUST include its `id`. Fields omitted from the payload are left
 * unchanged (partial update per row). Rows whose id is not found are collected
 * in `notFound`.
 *
 * Code uniqueness: if a new code collides with another existing subject
 * (different id), that row is placed in `errors` and skipped.
 *
 * Round trips:
 *   1. Fetch all existing rows (names + codes + ids) — 1 query
 *   2. One UPDATE per changed row (Drizzle/SQLite doesn't support multi-row
 *      UPDATE with different values per row in a single statement)
 *   We use db.batch() to send all UPDATEs in one network round trip.
 */
export async function bulkUpdateSubjects(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  subjects: Array<{
    id: number;
    name?: string;
    code?: string | null;
    description?: string | null;
  }>
): Promise<{
  subjects: SchoolSubject[];
  notFound: number[];
  errors: string[];
  message: string;
}> {
  if (!subjects || subjects.length === 0) {
    throw new Error("No subjects provided");
  }
  if (subjects.length > 100) {
    throw new Error("Cannot update more than 100 subjects at once");
  }

  const db = await getSchoolDB(env, schoolCode);

  // 1. Fetch all current subjects for collision checks
  const allExisting = await db
    .select({
      id: schoolSubjectsSchema.id,
      name: schoolSubjectsSchema.name,
      code: schoolSubjectsSchema.code,
    })
    .from(schoolSubjectsSchema)
    .all();

  const existingById = new Map(allExisting.map((e) => [e.id, e]));

  const notFound: number[] = [];
  const errors: string[] = [];

  // ── Helper that builds ONE update statement ─────────────────────────────
  // Declaring this as a small function lets TypeScript infer the *exact*
  // final chained type (after .set().where().returning()) on its own,
  // instead of us hand-writing Drizzle's internal generic signature —
  // which is exactly what broke last time (ReturnType<typeof db.update>
  // captures the builder BEFORE .set()/.where()/.returning(), not after).
  function buildUpdateStatement(id: number, setPayload: Record<string, any>) {
    return db
      .update(schoolSubjectsSchema)
      .set(setPayload)
      .where(eq(schoolSubjectsSchema.id, id))
      .returning();
  }

  // Now the array's element type is inferred correctly from the helper.
  const updateStatements: ReturnType<typeof buildUpdateStatement>[] = [];
  const updatedRows: SchoolSubject[] = [];

  // Track names/codes chosen in THIS batch to catch intra-batch collisions
  const batchNames = new Map<string, number>(); // name_lower → id
  const batchCodes = new Map<string, number>(); // code_lower → id

  for (const s of subjects) {
    const existing = existingById.get(s.id);

    if (!existing) {
      notFound.push(s.id);
      continue;
    }

    const newName = s.name?.trim() ?? existing.name;
    const newCode =
      s.code !== undefined
        ? s.code === null || s.code === ""
          ? null
          : s.code.trim()
        : existing.code;

    // ── Name collision check ─────────────────────────────────────────────
    const newNameLower = newName.toLowerCase();
    const existingWithName = allExisting.find(
      (e) => e.id !== s.id && e.name.toLowerCase() === newNameLower
    );
    const batchConflictName = batchNames.get(newNameLower);
    if (existingWithName || (batchConflictName && batchConflictName !== s.id)) {
      errors.push(
        `Subject id ${s.id} skipped — name "${newName}" conflicts with another subject`
      );
      continue;
    }

    // ── Code collision check ─────────────────────────────────────────────
    if (newCode) {
      const newCodeLower = newCode.toLowerCase();
      const existingWithCode = allExisting.find(
        (e) => e.id !== s.id && e.code && e.code.toLowerCase() === newCodeLower
      );
      const batchConflictCode = batchCodes.get(newCodeLower);
      if (
        existingWithCode ||
        (batchConflictCode && batchConflictCode !== s.id)
      ) {
        errors.push(
          `Subject id ${s.id} skipped — code "${newCode}" conflicts with another subject`
        );
        continue;
      }
      batchCodes.set(newCodeLower, s.id);
    }

    batchNames.set(newNameLower, s.id);

    // Build the SET payload — only include fields present in input
    const setPayload: Record<string, any> = {
      name: newName,
      code: newCode,
      updatedAt: new Date().toISOString(),
    };
    if (s.description !== undefined) {
      setPayload["description"] = s.description;
    }

    updateStatements.push(buildUpdateStatement(s.id, setPayload));
  }

  if (updateStatements.length === 0) {
    return {
      subjects: [],
      notFound,
      errors,
      message:
        notFound.length > 0
          ? `No subjects updated — ${notFound.length} id(s) not found`
          : "Nothing to update",
    };
  }

  // 2. Execute all updates in one batch round trip
  // ── Cast target derived directly from db.batch()'s OWN parameter type
  // (via Parameters<typeof db.batch>[0]) rather than us hand-writing the
  // expected tuple shape. This guarantees the cast always matches whatever
  // Drizzle's actual batch() signature is — including across version
  // upgrades — instead of drifting out of sync with it like the previous
  // manually-written tuple type did.
  const batchResults = await db.batch(
    updateStatements as unknown as Parameters<typeof db.batch>[0]
  );

  for (const result of batchResults) {
    if (Array.isArray(result) && result.length > 0) {
      updatedRows.push(result[0] as SchoolSubject);
    }
  }

  const total = updatedRows.length;
  let message = `${total} subject(s) updated successfully`;
  if (notFound.length > 0) message += `, ${notFound.length} not found`;
  if (errors.length > 0) message += `, ${errors.length} error(s)`;

  return { subjects: updatedRows, notFound, errors, message };
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
