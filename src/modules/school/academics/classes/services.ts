import { eq } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolStudentEnrollmentsSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";

// ==================== Create Class ====================
export async function createClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  // Check uniqueness (code logic)
  const existing = await db
    .select()
    .from(schoolClassesSchema)
    .where(eq(schoolClassesSchema.name, data.name))
    .get();

  if (existing) throw new Error("Class name already exists");

  const [newClass] = await db
    .insert(schoolClassesSchema)
    .values(data)
    .returning();

  return { class: newClass, message: "Class created successfully" };
}

// ==================== Get Classes ====================
export async function getClasses(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select()
    .from(schoolClassesSchema)
    .orderBy(schoolClassesSchema.sort_order);
}

// ==================== Update Class ====================
export async function updateClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolClassesSchema)
    .set(data)
    .where(eq(schoolClassesSchema.id, id))
    .returning();

  if (!updated) throw new Error("Class not found");

  return { class: updated, message: "Class updated successfully" };
}

// ==================== Delete Class ====================
export async function deleteClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Check if used (production safety)
  const used = await db
    .select()
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolClassSectionsSchema.id,
        schoolStudentEnrollmentsSchema.classSectionId
      )
    )
    .where(eq(schoolClassSectionsSchema.classId, id))
    .limit(1)
    .get();

  if (used)
    throw new Error(
      "Cannot delete class — it has active sections with enrolled students"
    );

  const [deleted] = await db
    .delete(schoolClassesSchema)
    .where(eq(schoolClassesSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Class not found");

  return { message: "Class deleted successfully" };
}
