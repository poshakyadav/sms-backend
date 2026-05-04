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
import { and, eq, isNull, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MappingInput {
  currentClassSectionId: number;
  nextClassSectionId: number;
  /** null / undefined = GLOBAL mapping (reused every year) */
  academicYearId?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE SINGLE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a single class-section mapping.
 *
 * IMPORTANT: academicYearId is honoured as-is:
 *   - null / undefined  → GLOBAL mapping (reused every year, no year attached)
 *   - number            → year-specific mapping (overrides global for that year)
 *
 * The old behaviour of auto-filling the current year when none was provided
 * has been removed — callers must be explicit.
 */
export async function createNextMapping(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: MappingInput
) {
  const db = await getSchoolDB(env, schoolCode);

  // Validate: source ≠ target
  if (data.currentClassSectionId === data.nextClassSectionId) {
    throw new Error("Source and target class-sections must be different");
  }

  // Duplicate guard within same scope (global OR same year)
  const existingWhere = data.academicYearId
    ? and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          data.currentClassSectionId
        ),
        eq(schoolClassSectionMappingsSchema.academicYearId, data.academicYearId)
      )
    : and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          data.currentClassSectionId
        ),
        isNull(schoolClassSectionMappingsSchema.academicYearId)
      );

  const existing = await db
    .select({ id: schoolClassSectionMappingsSchema.id })
    .from(schoolClassSectionMappingsSchema)
    .where(existingWhere)
    .get();

  if (existing) {
    const scope = data.academicYearId
      ? `year ${data.academicYearId}`
      : "global scope";
    throw new Error(
      `A mapping already exists for this source class-section in ${scope}. Delete or edit it first.`
    );
  }

  const academicYearId: number | null = data.academicYearId ?? null;

  const [mapping] = await db
    .insert(schoolClassSectionMappingsSchema)
    .values({
      currentClassSectionId: data.currentClassSectionId,
      nextClassSectionId: data.nextClassSectionId,
      academicYearId,
    })
    .returning();

  const type = academicYearId
    ? "year-specific (overrides global for selected year)"
    : "global (reused automatically every year)";

  return {
    mapping,
    message: `Mapping created successfully — ${type}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK CREATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-creates multiple mappings in a transaction.
 * Each mapping's academicYearId is honoured exactly:
 *   - null → global
 *   - number → year-specific
 */
export async function createBulkMappings(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: MappingInput[]
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const errors: string[] = [];
    const values: {
      currentClassSectionId: number;
      nextClassSectionId: number;
      academicYearId: number | null;
    }[] = [];

    for (const item of data) {
      // Self-reference guard
      if (item.currentClassSectionId === item.nextClassSectionId) {
        errors.push(
          `Row with classSectionId ${item.currentClassSectionId}: source and target must be different`
        );
        continue;
      }

      const academicYearId: number | null = item.academicYearId ?? null;

      // Duplicate guard
      const existingWhere = academicYearId
        ? and(
            eq(
              schoolClassSectionMappingsSchema.currentClassSectionId,
              item.currentClassSectionId
            ),
            eq(schoolClassSectionMappingsSchema.academicYearId, academicYearId)
          )
        : and(
            eq(
              schoolClassSectionMappingsSchema.currentClassSectionId,
              item.currentClassSectionId
            ),
            isNull(schoolClassSectionMappingsSchema.academicYearId)
          );

      const existing = await tx
        .select({ id: schoolClassSectionMappingsSchema.id })
        .from(schoolClassSectionMappingsSchema)
        .where(existingWhere)
        .get();

      if (existing) {
        const scope = academicYearId
          ? `year ${academicYearId}`
          : "global scope";
        errors.push(
          `ClassSection ${item.currentClassSectionId}: mapping already exists in ${scope}`
        );
        continue;
      }

      values.push({
        currentClassSectionId: item.currentClassSectionId,
        nextClassSectionId: item.nextClassSectionId,
        academicYearId,
      });
    }

    if (values.length === 0) {
      throw new Error(
        `No valid mappings to create. Errors: ${errors.join("; ")}`
      );
    }

    const inserted = await tx
      .insert(schoolClassSectionMappingsSchema)
      .values(values)
      .returning();

    // Fetch full UI-friendly list
    const fullMappings = await getClassSectionMappings(env, schoolCode);

    return {
      message: `Successfully created ${inserted.length} mapping(s)${
        errors.length > 0
          ? ` (${errors.length} skipped: ${errors.join("; ")})`
          : ""
      }`,
      created: inserted.length,
      skipped: errors.length,
      errors,
      mappings: fullMappings,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL MAPPINGS  (with optional filter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all mappings with full display names.
 *
 * @param scope
 *   - "global"           → only global mappings (academicYearId IS NULL)
 *   - number             → only mappings for that academic year
 *   - undefined / "all"  → everything
 */
export async function getClassSectionMappings(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  scope?: "global" | "all" | number
) {
  const db = await getSchoolDB(env, schoolCode);

  const nextClassSections = alias(
    schoolClassSectionsSchema,
    "nextClassSection"
  );
  const nextClasses = alias(schoolClassesSchema, "nextClass");
  const nextSections = alias(schoolSectionsSchema, "nextSection");

  const baseQuery = db
    .select({
      id: schoolClassSectionMappingsSchema.id,
      currentClassSectionId:
        schoolClassSectionMappingsSchema.currentClassSectionId,
      currentDisplayName:
        sql<string>`${schoolClassesSchema.name} || ' - ' || ${schoolSectionsSchema.name}`.as(
          "currentDisplayName"
        ),
      nextClassSectionId: schoolClassSectionMappingsSchema.nextClassSectionId,
      nextDisplayName:
        sql<string>`${nextClasses.name} || ' - ' || ${nextSections.name}`.as(
          "nextDisplayName"
        ),
      academicYearId: schoolClassSectionMappingsSchema.academicYearId,
      academicYearName: schoolAcademicYearsSchema.name,
      isGlobal:
        sql<boolean>`CASE WHEN ${schoolClassSectionMappingsSchema.academicYearId} IS NULL THEN 1 ELSE 0 END`.as(
          "isGlobal"
        ),
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
    );

  // Apply scope filter
  if (scope === "global") {
    return await baseQuery
      .where(isNull(schoolClassSectionMappingsSchema.academicYearId))
      .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name)
      .all();
  }

  if (typeof scope === "number") {
    return await baseQuery
      .where(eq(schoolClassSectionMappingsSchema.academicYearId, scope))
      .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name)
      .all();
  }

  // Default: all mappings
  return await baseQuery
    .orderBy(
      // Global first, then by year desc
      sql`CASE WHEN ${schoolClassSectionMappingsSchema.academicYearId} IS NULL THEN 0 ELSE 1 END`,
      schoolClassesSchema.sort_order,
      schoolSectionsSchema.name
    )
    .all();
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE MAPPING
// ─────────────────────────────────────────────────────────────────────────────

export async function updateMapping(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: Partial<MappingInput>
) {
  const db = await getSchoolDB(env, schoolCode);

  // Fetch existing to validate
  const existing = await db
    .select()
    .from(schoolClassSectionMappingsSchema)
    .where(eq(schoolClassSectionMappingsSchema.id, id))
    .get();

  if (!existing) throw new Error("Mapping not found");

  const newCurrentId =
    data.currentClassSectionId ?? existing.currentClassSectionId;
  const newNextId = data.nextClassSectionId ?? existing.nextClassSectionId;

  if (newCurrentId === newNextId) {
    throw new Error("Source and target class-sections must be different");
  }

  // academicYearId: explicit null means "make global", undefined means "keep existing"
  const newAcademicYearId =
    data.academicYearId !== undefined
      ? data.academicYearId
      : existing.academicYearId;

  // Duplicate guard (exclude self)
  const duplicateWhere = newAcademicYearId
    ? and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          newCurrentId
        ),
        eq(schoolClassSectionMappingsSchema.academicYearId, newAcademicYearId)
      )
    : and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          newCurrentId
        ),
        isNull(schoolClassSectionMappingsSchema.academicYearId)
      );

  const duplicate = await db
    .select({ id: schoolClassSectionMappingsSchema.id })
    .from(schoolClassSectionMappingsSchema)
    .where(duplicateWhere)
    .get();

  if (duplicate && duplicate.id !== id) {
    throw new Error(
      "Another mapping already exists for this source class-section in the same scope"
    );
  }

  const [updated] = await db
    .update(schoolClassSectionMappingsSchema)
    .set({
      currentClassSectionId: newCurrentId,
      nextClassSectionId: newNextId,
      academicYearId: newAcademicYearId ?? null,
    })
    .where(eq(schoolClassSectionMappingsSchema.id, id))
    .returning();

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

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE NEXT CLASS-SECTION FOR A STUDENT (used during promotion)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the next class-section for a given current class-section.
 *
 * Priority order (matches production promotion logic):
 *   1. Year-specific mapping for the current academic year
 *   2. Global mapping (academicYearId IS NULL)
 *   3. null → no mapping found, caller decides fallback
 */
export async function resolveNextClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  currentClassSectionId: number,
  currentAcademicYearId: number
): Promise<number | null> {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Year-specific
  const yearSpecific = await db
    .select({ nextId: schoolClassSectionMappingsSchema.nextClassSectionId })
    .from(schoolClassSectionMappingsSchema)
    .where(
      and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          currentClassSectionId
        ),
        eq(
          schoolClassSectionMappingsSchema.academicYearId,
          currentAcademicYearId
        )
      )
    )
    .get();

  if (yearSpecific) return yearSpecific.nextId;

  // 2. Global
  const global = await db
    .select({ nextId: schoolClassSectionMappingsSchema.nextClassSectionId })
    .from(schoolClassSectionMappingsSchema)
    .where(
      and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          currentClassSectionId
        ),
        isNull(schoolClassSectionMappingsSchema.academicYearId)
      )
    )
    .get();

  return global?.nextId ?? null;
}
