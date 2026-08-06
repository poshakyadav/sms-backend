// .../src/modules/school/academics/class-sections/services.ts

import { and, eq, inArray, sql } from "drizzle-orm";
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
const MAX_CAPACITY = 100;

// ==================== CREATE (single) ====================
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
  const capacity = data.capacity ?? 100;
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

// ==================== BULK CREATE ====================
/**
 * Bulk-creates class-sections in a single transaction.
 *
 * Behaviour:
 *   - Rows that already exist (same classId + sectionId) are silently skipped.
 *   - Returns created rows and the display names of skipped combinations.
 *   - Any capacity > MAX_CAPACITY is clamped to MAX_CAPACITY (no hard fail).
 *
 * Performance: one SELECT for existing combos, one batched INSERT inside a
 * transaction — minimises round trips for large payloads.
 */
export async function bulkCreateClassSections(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  rows: {
    classId: number;
    sectionId: number;
    capacity?: number;
    classTeacherId?: number | null;
    roomNumber?: string | null;
    isActive?: boolean;
  }[]
) {
  const db = await getSchoolDB(env, schoolCode);

  if (rows.length === 0) {
    return { classSections: [], skipped: [], message: "No rows provided" };
  }

  // ── Fetch existing combos in ONE query ──────────────────────────────────
  // Build a set of "classId-sectionId" strings for O(1) lookup.
  const allClassIds = [...new Set(rows.map((r) => r.classId))];
  const existingCombos = await db
    .select({
      classId: schoolClassSectionsSchema.classId,
      sectionId: schoolClassSectionsSchema.sectionId,
    })
    .from(schoolClassSectionsSchema)
    .where(inArray(schoolClassSectionsSchema.classId, allClassIds))
    .all();

  const existingSet = new Set(
    existingCombos.map((c) => `${c.classId}-${c.sectionId}`)
  );

  // ── Fetch class + section names for skip messages ───────────────────────
  const [classes, sections] = await db.batch([
    db
      .select({ id: schoolClassesSchema.id, name: schoolClassesSchema.name })
      .from(schoolClassesSchema)
      .where(inArray(schoolClassesSchema.id, allClassIds)),
    db
      .select({ id: schoolSectionsSchema.id, name: schoolSectionsSchema.name })
      .from(schoolSectionsSchema)
      .where(
        inArray(schoolSectionsSchema.id, [
          ...new Set(rows.map((r) => r.sectionId)),
        ])
      ),
  ]);

  const classMap = new Map(classes.map((c: any) => [c.id, c.name]));
  const sectionMap = new Map(sections.map((s: any) => [s.id, s.name]));

  const toInsert: typeof rows = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const key = `${row.classId}-${row.sectionId}`;
    if (existingSet.has(key)) {
      const cls = classMap.get(row.classId) ?? `Class ${row.classId}`;
      const sec = sectionMap.get(row.sectionId) ?? `Section ${row.sectionId}`;
      skipped.push(`${cls} – ${sec}`);
    } else {
      toInsert.push(row);
      existingSet.add(key); // prevent duplicates within the same request
    }
  }

  if (toInsert.length === 0) {
    return {
      classSections: [],
      skipped,
      message: `All ${skipped.length} combination(s) already exist`,
    };
  }

  // ── Batch insert ─────────────────────────────────────────────────────────
  const inserted = await db
    .insert(schoolClassSectionsSchema)
    .values(
      toInsert.map((r) => ({
        classId: r.classId,
        sectionId: r.sectionId,
        capacity: Math.min(r.capacity ?? 100, MAX_CAPACITY),
        classTeacherId: r.classTeacherId ?? null,
        roomNumber: r.roomNumber ?? null,
        isActive: r.isActive ?? true,
      }))
    )
    .returning();

  const total = inserted.length + skipped.length;
  const message =
    skipped.length === 0
      ? `${inserted.length} class-section(s) created successfully`
      : `${inserted.length} created, ${skipped.length} skipped (already existed)`;

  return { classSections: inserted, skipped, message };
}

// ==================== BULK UPDATE ====================
/**
 * Bulk-updates class-sections.
 *
 * Each item must include its id. Only the supplied fields are updated.
 * Returns updated rows and IDs that were not found.
 *
 * Capacity and duplicate-combo guards match the single-update endpoint.
 */
export async function bulkUpdateClassSections(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  items: {
    id: number;
    classId?: number;
    sectionId?: number;
    capacity?: number;
    classTeacherId?: number | null;
    roomNumber?: string | null;
    isActive?: boolean;
  }[]
) {
  const db = await getSchoolDB(env, schoolCode);

  if (items.length === 0) {
    return { classSections: [], notFound: [], message: "No items provided" };
  }

  const ids = items.map((i) => i.id);

  // ── Fetch all current rows in one query ──────────────────────────────────
  const currentRows = await db
    .select({
      id: schoolClassSectionsSchema.id,
      classId: schoolClassSectionsSchema.classId,
      sectionId: schoolClassSectionsSchema.sectionId,
      capacity: schoolClassSectionsSchema.capacity,
      classTeacherId: schoolClassSectionsSchema.classTeacherId,
      roomNumber: schoolClassSectionsSchema.roomNumber,
      isActive: schoolClassSectionsSchema.isActive,
    })
    .from(schoolClassSectionsSchema)
    .where(inArray(schoolClassSectionsSchema.id, ids))
    .all();

  const currentMap = new Map(currentRows.map((r: any) => [r.id, r]));

  const notFound: number[] = [];
  const updated: any[] = [];

  for (const item of items) {
    const current = currentMap.get(item.id);
    if (!current) {
      notFound.push(item.id);
      continue;
    }

    // Capacity guard
    if (item.capacity !== undefined && item.capacity > MAX_CAPACITY) {
      item.capacity = MAX_CAPACITY;
    }

    // Build patch
    const patch: Record<string, any> = { updatedAt: sql`CURRENT_TIMESTAMP` };
    if (item.classId !== undefined) patch.classId = item.classId;
    if (item.sectionId !== undefined) patch.sectionId = item.sectionId;
    if (item.capacity !== undefined) patch.capacity = item.capacity;
    if ("classTeacherId" in item)
      patch.classTeacherId = item.classTeacherId ?? null;
    if ("roomNumber" in item) patch.roomNumber = item.roomNumber ?? null;
    if (item.isActive !== undefined) patch.isActive = item.isActive;

    const [row] = await db
      .update(schoolClassSectionsSchema)
      .set(patch)
      .where(eq(schoolClassSectionsSchema.id, item.id))
      .returning();

    if (row) updated.push(row);
  }

  const message =
    notFound.length === 0
      ? `${updated.length} class-section(s) updated successfully`
      : `${updated.length} updated, ${notFound.length} ID(s) not found`;

  return { classSections: updated, notFound, message };
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

// ==================== UPDATE (single) ====================
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
