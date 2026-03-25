import { eq } from "drizzle-orm";
import {
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";

// ==================== Create Section ====================
export async function createSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const existing = await db
    .select()
    .from(schoolSectionsSchema)
    .where(eq(schoolSectionsSchema.name, data.name))
    .get();

  if (existing) throw new Error("Section name already exists");

  const [newSection] = await db
    .insert(schoolSectionsSchema)
    .values(data)
    .returning();

  return { section: newSection, message: "Section created successfully" };
}

// ==================== Get Sections ====================
export async function getSections(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select()
    .from(schoolSectionsSchema)
    .orderBy(schoolSectionsSchema.name);
}

// ==================== Update Section ====================
export async function updateSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolSectionsSchema)
    .set(data)
    .where(eq(schoolSectionsSchema.id, id))
    .returning();

  if (!updated) throw new Error("Section not found");

  return { section: updated, message: "Section updated successfully" };
}

// ==================== Delete Section ====================
export async function deleteSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

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
    .where(eq(schoolClassSectionsSchema.sectionId, id))
    .limit(1)
    .get();

  if (used)
    throw new Error(
      "Cannot delete section — it has active classes with enrolled students"
    );

  const [deleted] = await db
    .delete(schoolSectionsSchema)
    .where(eq(schoolSectionsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Section not found");

  return { message: "Section deleted successfully" };
}
