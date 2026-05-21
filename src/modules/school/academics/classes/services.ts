// …/school/academics/classes/services.ts

import { eq, inArray } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolStudentEnrollmentsSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassInput {
  name: string;
  level: number;
  sort_order: number;
}

interface BulkUpdateItem {
  id: number;
  name?: string;
  level?: number;
  sort_order?: number;
}

// ==================== Create Class ====================
export async function createClass(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: ClassInput
) {
  const db = await getSchoolDB(env, schoolCode);

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
  data: Partial<ClassInput>
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

// ==================== Bulk Create Classes ====================
/**
 * Creates multiple classes in a single DB transaction.
 *
 * Strategy:
 *   1. Fetch all existing names in one query.
 *   2. Split input into "to create" vs "skipped" (duplicates).
 *   3. Insert all non-duplicate rows atomically.
 *
 * Returns:
 *   classes  → newly created class records
 *   skipped  → names that already existed (not inserted)
 *   message  → human-readable summary
 */
export async function bulkCreateClasses(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  items: ClassInput[]
): Promise<{
  classes: any[];
  skipped: string[];
  message: string;
}> {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Deduplicate within the request payload itself (case-insensitive)
  const seen = new Map<string, ClassInput>();
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...item, name: item.name.trim() });
  }
  const deduped = Array.from(seen.values());

  // 2. Find which names already exist in DB
  const names = deduped.map((d) => d.name);
  const existingRows = await db
    .select({ name: schoolClassesSchema.name })
    .from(schoolClassesSchema)
    .all();

  const existingNamesLower = new Set(
    existingRows.map((r) => r.name.toLowerCase())
  );

  const toCreate = deduped.filter(
    (d) => !existingNamesLower.has(d.name.toLowerCase())
  );
  const skipped = deduped
    .filter((d) => existingNamesLower.has(d.name.toLowerCase()))
    .map((d) => d.name);

  if (toCreate.length === 0) {
    return {
      classes: [],
      skipped,
      message:
        skipped.length > 0
          ? `All ${skipped.length} class name(s) already exist. Nothing was created.`
          : "No classes to create.",
    };
  }

  // 3. Insert in transaction
  let created: any[] = [];

  await db.transaction(async (tx: any) => {
    created = await tx.insert(schoolClassesSchema).values(toCreate).returning();
  });

  const msg =
    skipped.length > 0
      ? `Created ${created.length} class(es). Skipped ${
          skipped.length
        } duplicate(s): ${skipped.join(", ")}.`
      : `Successfully created ${created.length} class(es).`;

  return { classes: created, skipped, message: msg };
}

// ==================== Bulk Update Classes ====================
/**
 * Updates multiple classes in a single DB transaction.
 *
 * Strategy:
 *   1. Verify all IDs exist first (fail-fast).
 *   2. For each item, apply only the provided fields.
 *   3. Return updated records + any IDs not found.
 *
 * Returns:
 *   classes   → updated class records
 *   notFound  → IDs that did not exist
 *   message   → human-readable summary
 */
export async function bulkUpdateClasses(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  items: BulkUpdateItem[]
): Promise<{
  classes: any[];
  notFound: number[];
  message: string;
}> {
  const db = await getSchoolDB(env, schoolCode);

  const ids = items.map((i) => i.id);

  const existing = await db
    .select()
    .from(schoolClassesSchema)
    .where(inArray(schoolClassesSchema.id, ids))
    .all();

  const existingIds = new Set(existing.map((r) => r.id));
  const notFound = ids.filter((id) => !existingIds.has(id));
  const toUpdate = items.filter((i) => existingIds.has(i.id));

  if (toUpdate.length === 0) {
    return {
      classes: [],
      notFound,
      message: `No valid classes found to update. IDs not found: ${notFound.join(", ")}.`,
    };
  }

  const updated: any[] = [];

  await db.transaction(async (tx: any) => {
    for (const item of toUpdate) {
      const { id, ...rawPatch } = item;

      // ✅ FIX: Strip undefined values — Drizzle's .set() throws "No values to set"
      // if every key in the object is undefined, which happens because the Zod
      // schema marks name/level/sort_order as optional().
      const patch = Object.fromEntries(
        Object.entries(rawPatch).filter(([, v]) => v !== undefined)
      );

      if (Object.keys(patch).length === 0) continue;

      console.log(`[BulkUpdate] item id=${id}, patch:`, JSON.stringify(patch));

      const [updatedRow] = await tx
        .update(schoolClassesSchema)
        .set(patch)
        .where(eq(schoolClassesSchema.id, id))
        .returning();

      if (updatedRow) updated.push(updatedRow);
    }
  });

  const msg =
    notFound.length > 0
      ? `Updated ${updated.length} class(es). ${notFound.length} ID(s) not found: ${notFound.join(", ")}.`
      : `Successfully updated ${updated.length} class(es).`;

  return { classes: updated, notFound, message: msg };
}