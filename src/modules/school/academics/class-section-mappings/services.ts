import { alias } from "drizzle-orm/sqlite-core";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionMappingsSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";
import { eq, isNull, sql } from "drizzle-orm";

// ==================== Create Next Class-Section Mapping (Global or Year-Specific) ====================
// ==================== Single Create (Global or Year-Specific) ====================
export async function createNextMapping(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  let academicYearId: number | null = data.academicYearId ?? null;

  // If no year provided → default to current year (most common)
  if (!academicYearId) {
    const currentYear = await db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (currentYear) academicYearId = currentYear.id;
  }

  const [mapping] = await db
    .insert(schoolClassSectionMappingsSchema)
    .values({
      currentClassSectionId: data.currentClassSectionId,
      nextClassSectionId: data.nextClassSectionId,
      academicYearId,
    })
    .returning();

  const type = academicYearId
    ? "year-specific"
    : "global (reusable every year)";
  return {
    mapping,
    message: `Mapping created successfully (${type})`,
  };
}

// ==================== BULK CREATE (New - Production Grade) ====================
export async function createBulkMappings(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any[] // array of mappings
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // Default to current year for any mapping without academicYearId
    let currentYearId: number | null = null;
    const currentYear = await tx
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (currentYear) currentYearId = currentYear.id;

    const values = data.map((item) => ({
      currentClassSectionId: item.currentClassSectionId,
      nextClassSectionId: item.nextClassSectionId,
      academicYearId: item.academicYearId ?? currentYearId,
    }));

    const inserted = await tx
      .insert(schoolClassSectionMappingsSchema)
      .values(values)
      .returning();

    // UI-friendly response: fetch full details with names
    const fullMappings = await getClassSectionMappings(env, schoolCode); // re-use existing function

    return {
      message: `Successfully created ${inserted.length} mappings`,
      created: inserted.length,
      mappings: fullMappings, // ← UI-friendly with display names + isGlobal
    };
  });
}

// ==================== Get All (UI-friendly with aliases) ====================
export async function getClassSectionMappings(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const nextClassSections = alias(
    schoolClassSectionsSchema,
    "nextClassSection"
  );
  const nextClasses = alias(schoolClassesSchema, "nextClass");
  const nextSections = alias(schoolSectionsSchema, "nextSection");

  return await db
    .select({
      id: schoolClassSectionMappingsSchema.id,
      currentClassSectionId:
        schoolClassSectionMappingsSchema.currentClassSectionId,
      currentDisplayName:
        sql`${schoolClassesSchema.name} || ' - ' || ${schoolSectionsSchema.name}`.as(
          "currentDisplayName"
        ),
      nextClassSectionId: schoolClassSectionMappingsSchema.nextClassSectionId,
      nextDisplayName:
        sql`${nextClasses.name} || ' - ' || ${nextSections.name}`.as(
          "nextDisplayName"
        ),
      academicYearId: schoolClassSectionMappingsSchema.academicYearId,
      academicYearName: schoolAcademicYearsSchema.name,
      isGlobal: isNull(schoolClassSectionMappingsSchema.academicYearId),
    })
    .from(schoolClassSectionMappingsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionMappingsSchema.currentClassSectionId,
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
    .innerJoin(
      nextClassSections,
      eq(
        schoolClassSectionMappingsSchema.nextClassSectionId,
        nextClassSections.id
      )
    )
    .innerJoin(nextClasses, eq(nextClassSections.classId, nextClasses.id))
    .innerJoin(nextSections, eq(nextClassSections.sectionId, nextSections.id))
    .leftJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolClassSectionMappingsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name);
}

// ==================== Update Class-Section Mapping ====================
export async function updateMapping(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolClassSectionMappingsSchema)
    .set({
      nextClassSectionId: data.nextClassSectionId,
      academicYearId: data.academicYearId ?? null,
    })
    .where(eq(schoolClassSectionMappingsSchema.id, id))
    .returning();

  if (!updated) throw new Error("Mapping not found");

  return { mapping: updated, message: "Mapping updated successfully" };
}

// ==================== Delete Class-Section Mapping (with safety) ====================
export async function deleteMapping(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Safety: Check if this mapping was used in any enrollment
  const used = await db
    .select()
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolClassSectionMappingsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionMappingsSchema.nextClassSectionId
      )
    )
    .where(eq(schoolClassSectionMappingsSchema.id, id))
    .limit(1)
    .get();

  if (used)
    throw new Error(
      "Cannot delete mapping — it is being used by promoted students"
    );

  const [deleted] = await db
    .delete(schoolClassSectionMappingsSchema)
    .where(eq(schoolClassSectionMappingsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Mapping not found");

  return { message: "Mapping deleted successfully" };
}
