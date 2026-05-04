import { and, eq, sql } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";

/** Single source of truth — mirrors the value in routes.ts and the frontend. */
const MAX_CAPACITY = 50;

// ==================== CREATE ====================
export async function createClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    classId: number;
    sectionId: number;
    capacity?: number;
    classTeacherId?: number | null;
    roomNumber?: string | null;
    isActive?: boolean;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  // Guard: duplicate combination
  const existing = await db
    .select({ id: schoolClassSectionsSchema.id })
    .from(schoolClassSectionsSchema)
    .where(
      and(
        eq(schoolClassSectionsSchema.classId, data.classId),
        eq(schoolClassSectionsSchema.sectionId, data.sectionId)
      )
    )
    .get();

  if (existing)
    throw new Error("This class-section combination already exists");

  // Guard: capacity cap (belt-and-suspenders — Zod already rejects >50)
  const capacity = data.capacity ?? 40;
  if (capacity > MAX_CAPACITY) {
    throw new Error(
      `Capacity cannot exceed ${MAX_CAPACITY} students per section`
    );
  }

  const [newSection] = await db
    .insert(schoolClassSectionsSchema)
    .values({
      classId: data.classId,
      sectionId: data.sectionId,
      capacity,
      classTeacherId: data.classTeacherId ?? null,
      roomNumber: data.roomNumber ?? null,
      isActive: data.isActive ?? true,
    })
    .returning();

  return {
    classSection: newSection,
    message: "Class-section created successfully",
  };
}

// ==================== GET ALL ====================
export async function getClassSections(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionsSchema.id,
      classId: schoolClassSectionsSchema.classId,
      className: schoolClassesSchema.name,
      sectionId: schoolClassSectionsSchema.sectionId,
      sectionName: schoolSectionsSchema.name,
      capacity: schoolClassSectionsSchema.capacity,
      classTeacherId: schoolClassSectionsSchema.classTeacherId,
      classTeacherName: schoolUsersSchema.name,
      roomNumber: schoolClassSectionsSchema.roomNumber,
      isActive: schoolClassSectionsSchema.isActive,
      currentStudents: db.$count(
        schoolStudentEnrollmentsSchema,
        and(
          eq(
            schoolStudentEnrollmentsSchema.classSectionId,
            schoolClassSectionsSchema.id
          ),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      ),
    })
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .leftJoin(
      schoolUsersSchema,
      eq(schoolClassSectionsSchema.classTeacherId, schoolUsersSchema.id)
    )
    .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name);
}

// ==================== GET AVAILABLE FOR ENROLLMENT ====================
export async function getAvailableClassSectionsForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionsSchema.id,
      displayName:
        sql<string>`${schoolClassesSchema.name} || ' - ' || ${schoolSectionsSchema.name}`.as(
          "displayName"
        ),
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      capacity: schoolClassSectionsSchema.capacity,
      currentStudents: db.$count(
        schoolStudentEnrollmentsSchema,
        and(
          eq(
            schoolStudentEnrollmentsSchema.classSectionId,
            schoolClassSectionsSchema.id
          ),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      ),
    })
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolClassSectionsSchema.isActive, true))
    .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name);
}

// ==================== UPDATE ====================
export async function updateClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: Partial<{
    classId: number;
    sectionId: number;
    capacity: number;
    classTeacherId: number | null;
    roomNumber: string | null;
    isActive: boolean;
  }>
) {
  const db = await getSchoolDB(env, schoolCode);

  // Guard: capacity cap
  if (data.capacity !== undefined && data.capacity > MAX_CAPACITY) {
    throw new Error(
      `Capacity cannot exceed ${MAX_CAPACITY} students per section`
    );
  }

  // Guard: record must exist
  const existing = await db
    .select({ id: schoolClassSectionsSchema.id })
    .from(schoolClassSectionsSchema)
    .where(eq(schoolClassSectionsSchema.id, id))
    .get();

  if (!existing) throw new Error("Class-section not found");

  // Guard: if changing class+section combo, ensure uniqueness
  if (data.classId !== undefined || data.sectionId !== undefined) {
    const current = await db
      .select({
        classId: schoolClassSectionsSchema.classId,
        sectionId: schoolClassSectionsSchema.sectionId,
      })
      .from(schoolClassSectionsSchema)
      .where(eq(schoolClassSectionsSchema.id, id))
      .get();

    const newClassId = data.classId ?? current!.classId;
    const newSectionId = data.sectionId ?? current!.sectionId;

    const duplicate = await db
      .select({ id: schoolClassSectionsSchema.id })
      .from(schoolClassSectionsSchema)
      .where(
        and(
          eq(schoolClassSectionsSchema.classId, newClassId),
          eq(schoolClassSectionsSchema.sectionId, newSectionId)
        )
      )
      .get();

    // Allow if the only match is the record being updated
    if (duplicate && duplicate.id !== id) {
      throw new Error("This class-section combination already exists");
    }
  }

  const [updated] = await db
    .update(schoolClassSectionsSchema)
    .set({ ...data, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schoolClassSectionsSchema.id, id))
    .returning();

  return {
    classSection: updated,
    message: "Class-section updated successfully",
  };
}

// ==================== DELETE ====================
export async function deleteClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const hasEnrollments = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, id),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .limit(1)
    .get();

  if (hasEnrollments) {
    throw new Error(
      "Cannot delete class-section with active enrolled students"
    );
  }

  const [deleted] = await db
    .delete(schoolClassSectionsSchema)
    .where(eq(schoolClassSectionsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Class-section not found");
  return { message: "Class-section deleted successfully" };
}
