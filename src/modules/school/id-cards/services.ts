// src/modules/school/id-cards/services.ts

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  IdCardHolderTypeValue,
  idCardsSchema,
  IdCardStatus,
  IdCardStatusValue,
  idCardTemplatesSchema,
} from "../../../db/schemas/school";
import { schoolClassSectionsSchema } from "../../../db/schemas/school/school-class-sections";
import { schoolClassesSchema } from "../../../db/schemas/school/school-classes";
import { schoolSectionsSchema } from "../../../db/schemas/school/school-sections";
import { schoolStudentEnrollmentsSchema } from "../../../db/schemas/school/school-student-enrollments";
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { staffSchema } from "../../../db/schemas/school/staff";
import { studentsSchema } from "../../../db/schemas/school/students";
import { teachersSchema } from "../../../db/schemas/school/teachers";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Role-specific fields frozen into id_cards.detailsSnapshot at issue time. */
export interface IdCardDetailsSnapshot {
  // Student fields
  className?: string;
  sectionName?: string;
  rollNumber?: string;
  admissionNumber?: string;
  // Staff fields
  designation?: string;
  department?: string;
  employeeCode?: string;
  // Shared
  bloodGroup?: string;
  dateOfBirth?: string;
}

/** Full payload returned to the frontend for rendering + PDF export. */
export interface IdCardData {
  id: number;
  cardNumber: string;
  holderType: IdCardHolderTypeValue;
  holderName: string;
  photoUrl: string | null;
  details: IdCardDetailsSnapshot;
  issuedAt: string;
  validUntil: string;
  status: string;
  verificationUrl: string;
  template: {
    id: number;
    name: string;
    layoutConfig: Record<string, unknown>;
  };
  school: {
    name: string;
    shortName: string | null;
    logoUrl: string | null;
    tagline: string | null;
    addressLineOne: string;
    addressLineTwo: string;
    phone: string;
  };
}

interface GenerateCardInput {
  holderUserId: number;
  templateId: number;
  validUntil: string; // ISO date
  issuedBy: number;
  /** Required when the holder is a student — pins the issued card to a
   *  specific academic-year enrollment, per the schema comment rationale. */
  enrollmentId?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID / TOKEN GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a short, human-readable, sequential-looking card number,
 * e.g. "EDX-2026-000123". Uses the school's short name (or "ID" fallback)
 * + current year + a zero-padded counter derived from row count + random
 * suffix to avoid a hot-row counter table while keeping numbers tidy.
 *
 * NOTE: actual uniqueness is enforced by the DB unique index
 * (uq_id_card_number_per_school) — on collision (astronomically rare given
 * the random suffix), the caller should retry once.
 */
export function generateCardNumber(schoolShortCode: string): string {
  const year = new Date().getFullYear();
  const randomPart = Math.floor(100000 + Math.random() * 900000); // 6 digits
  const prefix = (schoolShortCode || "ID")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return `${prefix}-${year}-${randomPart}`;
}

/**
 * Generates an opaque, unguessable verification token for the QR code.
 * Uses Web Crypto (available in the Workers runtime) — no Node `crypto`
 * dependency. 32 random bytes, base64url-encoded → 43-char URL-safe token.
 */
export function generateVerificationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let base64 = btoa(String.fromCharCode(...bytes));
  // base64url: replace +/ and strip padding so it's safe in a URL path segment
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT BUILDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the frozen detailsSnapshot for a STUDENT card by joining the
 * specified enrollment → class-section → class/section, plus the student's
 * admission number and the user's blood group / DOB.
 */
async function buildStudentSnapshot(
  db: any,
  holderUserId: number,
  enrollmentId: number
): Promise<IdCardDetailsSnapshot> {
  const row = await db
    .select({
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      admissionNumber: studentsSchema.admissionNumber,
      bloodGroup: schoolUsersSchema.bloodGroup,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionsSchema.id,
        schoolStudentEnrollmentsSchema.classSectionId
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassesSchema.id, schoolClassSectionsSchema.classId)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolSectionsSchema.id, schoolClassSectionsSchema.sectionId)
    )
    .innerJoin(studentsSchema, eq(studentsSchema.userId, holderUserId))
    .innerJoin(schoolUsersSchema, eq(schoolUsersSchema.id, holderUserId))
    .where(eq(schoolStudentEnrollmentsSchema.id, enrollmentId))
    .get();

  if (!row) {
    throw new Error(
      "Enrollment not found for this student — cannot issue card"
    );
  }

  return {
    className: row.className,
    sectionName: row.sectionName,
    rollNumber: row.rollNumber ?? undefined,
    admissionNumber: row.admissionNumber ?? undefined,
    bloodGroup: row.bloodGroup || undefined,
    dateOfBirth: row.dateOfBirth || undefined,
  };
}

/**
 * Builds the frozen detailsSnapshot for a STAFF card (teacher or general
 * staff). Joins the teachers/staff profile table depending on which one
 * has a row for this user — a school_users row only ever has ONE profile
 * row across students/teachers/parents/staff (per primaryRole).
 */
async function buildStaffSnapshot(
  db: any,
  holderUserId: number
): Promise<IdCardDetailsSnapshot> {
  const user = await db
    .select({
      bloodGroup: schoolUsersSchema.bloodGroup,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      primaryRole: schoolUsersSchema.primaryRole,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, holderUserId))
    .get();

  if (!user) {
    throw new Error("Staff user not found — cannot issue card");
  }

  // Try staff profile first (designation/department), then teacher profile
  // (qualification/specialization used as a designation fallback).
  const staffRow = await db
    .select({
      designation: staffSchema.designation,
      department: staffSchema.department,
    })
    .from(staffSchema)
    .where(eq(staffSchema.userId, holderUserId))
    .get();

  if (staffRow) {
    return {
      designation: staffRow.designation,
      department: staffRow.department ?? undefined,
      employeeCode: `EMP-${holderUserId}`, // simple deterministic fallback; can be replaced by a real employeeCode field later
      bloodGroup: user.bloodGroup || undefined,
      dateOfBirth: user.dateOfBirth || undefined,
    };
  }

  const teacherRow = await db
    .select({
      specialization: teachersSchema.specialization,
    })
    .from(teachersSchema)
    .where(eq(teachersSchema.userId, holderUserId))
    .get();

  return {
    designation: "Teacher",
    department: teacherRow?.specialization ?? undefined,
    employeeCode: `EMP-${holderUserId}`,
    bloodGroup: user.bloodGroup || undefined,
    dateOfBirth: user.dateOfBirth || undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBLE HOLDERS — powers the "Generate Cards" dialog holder picker
// ─────────────────────────────────────────────────────────────────────────────

export interface EligibleHolder {
  userId: number;
  name: string;
  photoUrl: string | null;
  // Student-specific — undefined for STAFF
  enrollmentId?: number;
  rollNumber?: string | null;
  admissionNumber?: string | null;
  // Staff-specific — undefined for STUDENT
  designation?: string | null;
  /** True if this holder already has an ACTIVE card. Dialog surfaces this
   *  as a warning rather than blocking — a school may legitimately want to
   *  reissue-by-generating-fresh in edge cases, so we inform, not prevent. */
  hasActiveCard: boolean;

  /** id of the existing ACTIVE card when hasActiveCard is true — lets the
   *  frontend delete it inline instead of forcing a trip to the main table. */
  activeCardId: number | null;
}

export async function getEligibleHolders(
  db: any,
  params: { holderType: IdCardHolderTypeValue; classSectionId?: number }
): Promise<EligibleHolder[]> {
  if (params.holderType === "STUDENT") {
    if (!params.classSectionId) {
      throw new Error("classSectionId is required when holderType is STUDENT");
    }

    const rows = await db
      .select({
        userId: schoolUsersSchema.id,
        name: schoolUsersSchema.name,
        photoUrl: schoolUsersSchema.avatarUrl,
        enrollmentId: schoolStudentEnrollmentsSchema.id,
        rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
        admissionNumber: studentsSchema.admissionNumber,
        activeCardId: idCardsSchema.id,
      })
      .from(schoolStudentEnrollmentsSchema)
      .innerJoin(
        schoolUsersSchema,
        eq(schoolUsersSchema.id, schoolStudentEnrollmentsSchema.studentId)
      )
      .innerJoin(
        studentsSchema,
        eq(studentsSchema.userId, schoolStudentEnrollmentsSchema.studentId)
      )
      // LEFT JOIN scoped to ACTIVE only — if a student has a REVOKED/EXPIRED
      // card but no ACTIVE one, activeCardId stays null → hasActiveCard: false,
      // which is correct (they're eligible for a fresh card).
      .leftJoin(
        idCardsSchema,
        and(
          eq(idCardsSchema.enrollmentId, schoolStudentEnrollmentsSchema.id),
          eq(idCardsSchema.status, IdCardStatus.ACTIVE)
        )
      )
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.classSectionId, params.classSectionId),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .all();

    return rows.map((r: any) => ({
      userId: r.userId,
      name: r.name,
      photoUrl: r.photoUrl || null,
      enrollmentId: r.enrollmentId,
      rollNumber: r.rollNumber ?? null,
      admissionNumber: r.admissionNumber ?? null,
      hasActiveCard: r.activeCardId != null,
    }));
  }

  // ── STAFF: anyone whose primary identity isn't a student/parent ──────────
  const rows = await db
    .select({
      userId: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      photoUrl: schoolUsersSchema.avatarUrl,
      primaryRole: schoolUsersSchema.primaryRole,
      activeCardId: idCardsSchema.id,
    })
    .from(schoolUsersSchema)
    .leftJoin(
      idCardsSchema,
      and(
        eq(idCardsSchema.holderUserId, schoolUsersSchema.id),
        eq(idCardsSchema.holderType, "STAFF"),
        eq(idCardsSchema.status, IdCardStatus.ACTIVE)
      )
    )
    .where(
      and(
        eq(schoolUsersSchema.isActive, true),
        ne(schoolUsersSchema.primaryRole, "STUDENT"),
        ne(schoolUsersSchema.primaryRole, "STUDENT_PARENT")
      )
    )
    .all();

  return rows.map((r: any) => ({
    userId: r.userId,
    name: r.name,
    photoUrl: r.photoUrl || null,
    designation: r.primaryRole,
    hasActiveCard: r.activeCardId != null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST — lightweight list view for the ID Card Management table
// ─────────────────────────────────────────────────────────────────────────────

export interface ListIdCardsFilters {
  holderType?: IdCardHolderTypeValue;
  status?: IdCardStatusValue;
  /** Only meaningful when holderType === "STUDENT". Staff cards have
   *  enrollmentId = null, so combining this with STAFF (or omitting
   *  holderType) will just correctly return zero rows for staff. */
  classSectionId?: number;
}

export interface IdCardListRow {
  id: number;
  cardNumber: string;
  holderType: IdCardHolderTypeValue;
  holderName: string;
  photoUrl: string | null;
  status: string;
  issuedAt: string;
  validUntil: string;
  // Populated only for STUDENT rows via the enrollment → class-section join.
  className: string | null;
  sectionName: string | null;
}

export async function listIdCards(
  db: any,
  filters: ListIdCardsFilters
): Promise<IdCardListRow[]> {
  const conditions = [];

  if (filters.holderType) {
    conditions.push(eq(idCardsSchema.holderType, filters.holderType));
  }
  if (filters.status) {
    conditions.push(eq(idCardsSchema.status, filters.status));
  }
  if (filters.classSectionId) {
    conditions.push(
      eq(schoolStudentEnrollmentsSchema.classSectionId, filters.classSectionId)
    );
  }

  const rows = await db
    .select({
      id: idCardsSchema.id,
      cardNumber: idCardsSchema.cardNumber,
      holderType: idCardsSchema.holderType,
      holderName: idCardsSchema.holderNameSnapshot,
      photoUrl: idCardsSchema.photoUrlSnapshot,
      status: idCardsSchema.status,
      issuedAt: idCardsSchema.issuedAt,
      validUntil: idCardsSchema.validUntil,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(idCardsSchema)
    // LEFT JOINs — staff rows have enrollmentId = null and must still show up
    // when no classSectionId filter is applied.
    .leftJoin(
      schoolStudentEnrollmentsSchema,
      eq(schoolStudentEnrollmentsSchema.id, idCardsSchema.enrollmentId)
    )
    .leftJoin(
      schoolClassSectionsSchema,
      eq(schoolClassSectionsSchema.id, schoolStudentEnrollmentsSchema.classSectionId)
    )
    .leftJoin(schoolClassesSchema, eq(schoolClassesSchema.id, schoolClassSectionsSchema.classId))
    .leftJoin(schoolSectionsSchema, eq(schoolSectionsSchema.id, schoolClassSectionsSchema.sectionId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(idCardsSchema.issuedAt))
    .all();

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE — single card
// ─────────────────────────────────────────────────────────────────────────────

export async function generateIdCard(
  db: any,
  schoolShortCode: string,
  input: GenerateCardInput
): Promise<{ id: number }> {
  const user = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      avatarUrl: schoolUsersSchema.avatarUrl,
      primaryRole: schoolUsersSchema.primaryRole,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, input.holderUserId))
    .get();

  if (!user) {
    throw new Error("Holder not found");
  }

  const template = await db
    .select()
    .from(idCardTemplatesSchema)
    .where(eq(idCardTemplatesSchema.id, input.templateId))
    .get();

  if (!template) {
    throw new Error("Template not found");
  }

  const holderType: IdCardHolderTypeValue = template.holderType;
  const isStudent = holderType === "STUDENT";

  if (isStudent && !input.enrollmentId) {
    throw new Error("enrollmentId is required when issuing a STUDENT card");
  }

  // ── NEW: one-active-card-per-holder guard ─────────────────────────────
  const existingActive = await findActiveCardForHolder(
    db,
    holderType,
    input.holderUserId,
    isStudent ? input.enrollmentId : undefined
  );
  if (existingActive) {
    const err: any = new Error(
      "This holder already has an active ID card. Delete the existing card before generating a new one."
    );
    err.code = "ACTIVE_CARD_EXISTS";
    err.existingCardId = existingActive.id;
    throw err;
  }

  const details = isStudent
    ? await buildStudentSnapshot(db, input.holderUserId, input.enrollmentId!)
    : await buildStaffSnapshot(db, input.holderUserId);

  const cardNumber = generateCardNumber(schoolShortCode);
  const verificationToken = generateVerificationToken();

  const result = await db
    .insert(idCardsSchema)
    .values({
      holderType,
      holderUserId: input.holderUserId,
      enrollmentId: isStudent ? input.enrollmentId : null,
      templateId: input.templateId,
      cardNumber,
      verificationToken,
      holderNameSnapshot: user.name,
      photoUrlSnapshot: user.avatarUrl || null,
      detailsSnapshot: JSON.stringify(details),
      validUntil: input.validUntil,
      status: IdCardStatus.ACTIVE,
      issuedBy: input.issuedBy,
    })
    .returning({ id: idCardsSchema.id })
    .get();

  return { id: result.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE — bulk (by explicit user-id list; class-section/role expansion
// into a user-id list happens in the route handler, which already has
// access to the relevant list queries used elsewhere in the app)
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateFailure {
  holderUserId: number;
  error: string;
  code?: string;
  existingCardId?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE — bulk (BATCHED — see note below on why this replaced the
// naive per-holder loop)
//
// The old version called generateIdCard() once per holder, and each call
// did 5-7 sequential DB round trips (user lookup, template lookup, active-
// card check, snapshot join, insert). For N holders that's ~6N round trips
// — for 500 holders, 3000+ sequential network calls to Turso, which is
// exactly what produced the 19s response time.
//
// This version does the same work with a constant number of round trips:
// one batched SELECT per step (users, active cards, snapshots) plus one
// multi-row INSERT — regardless of how many holders are in the batch.
// ─────────────────────────────────────────────────────────────────────────────

export async function generateIdCardsBulk(
  db: any,
  schoolShortCode: string,
  params: {
    templateId: number;
    validUntil: string;
    issuedBy: number;
    holders: Array<{ holderUserId: number; enrollmentId?: number }>;
  }
): Promise<{ succeeded: number[]; failed: GenerateFailure[] }> {
  const { templateId, validUntil, issuedBy, holders } = params;
  const failed: GenerateFailure[] = [];

  if (holders.length === 0) return { succeeded: [], failed };

  // ── 1. Template fetched ONCE — every holder in a bulk request shares the
  // same templateId (see generateBulkSchema), so there's no reason to
  // re-fetch it per holder like the old loop did. ──────────────────────────
  const template = await db
    .select()
    .from(idCardTemplatesSchema)
    .where(eq(idCardTemplatesSchema.id, templateId))
    .get();

  if (!template) {
    return {
      succeeded: [],
      failed: holders.map((h) => ({ holderUserId: h.holderUserId, error: "Template not found" })),
    };
  }

  const holderType: IdCardHolderTypeValue = template.holderType;
  const isStudent = holderType === "STUDENT";

  // ── 2. Validate enrollmentId presence up front ───────────────────────────
  const validHolders: Array<{ holderUserId: number; enrollmentId?: number }> = [];
  for (const h of holders) {
    if (isStudent && !h.enrollmentId) {
      failed.push({ holderUserId: h.holderUserId, error: "enrollmentId is required when issuing a STUDENT card" });
      continue;
    }
    validHolders.push(h);
  }
  if (validHolders.length === 0) return { succeeded: [], failed };

  const holderUserIds = Array.from(new Set(validHolders.map((h) => h.holderUserId)));

  // ── 3. Batch-fetch holder users — 1 query instead of N ────────────────────
  const users = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      avatarUrl: schoolUsersSchema.avatarUrl,
    })
    .from(schoolUsersSchema)
    .where(inArray(schoolUsersSchema.id, holderUserIds))
    .all();

  // FIX: explicit <number, ...> generics — without this, TS collapses the
  // value type to `{}` (see note in batchBuildStaffSnapshots below), which
  // then breaks every `user.name` / `user.avatarUrl` access downstream.
  const userMap = new Map<number, { id: number; name: string; avatarUrl: string | null }>(
    users.map((u: any) => [u.id, u])
  );

  // ── 4. Batch-fetch existing ACTIVE cards for the whole set — 1 query
  // instead of N calls to findActiveCardForHolder(). ────────────────────────
  const activeCards = await db
    .select({
      id: idCardsSchema.id,
      holderUserId: idCardsSchema.holderUserId,
      enrollmentId: idCardsSchema.enrollmentId,
    })
    .from(idCardsSchema)
    .where(
      and(
        eq(idCardsSchema.holderType, holderType),
        inArray(idCardsSchema.holderUserId, holderUserIds),
        eq(idCardsSchema.status, IdCardStatus.ACTIVE)
      )
    )
    .all();

  const activeCardMap = new Map<string, number>();
  for (const c of activeCards) {
    const key = isStudent ? `${c.holderUserId}:${c.enrollmentId}` : `${c.holderUserId}`;
    activeCardMap.set(key, c.id);
  }

  // ── 5. Batch-fetch details snapshots — 1-2 queries instead of N joins ────
  let studentSnapshots: Map<number, IdCardDetailsSnapshot> | null = null;
  let staffSnapshots: Map<number, IdCardDetailsSnapshot> | null = null;

  if (isStudent) {
    const enrollmentIds = Array.from(new Set(validHolders.map((h) => h.enrollmentId!)));
    studentSnapshots = await batchBuildStudentSnapshots(db, enrollmentIds);
  } else {
    staffSnapshots = await batchBuildStaffSnapshots(db, holderUserIds);
  }

  // ── 6. Build insert rows in memory (no DB calls in this loop) ────────────
  const usedCardNumbers = new Set<string>();
  const insertValues: any[] = [];
  const rowMeta: Array<{ holderUserId: number }> = [];

  for (const h of validHolders) {
    const user = userMap.get(h.holderUserId);
    if (!user) {
      failed.push({ holderUserId: h.holderUserId, error: "Holder not found" });
      continue;
    }

    const activeKey = isStudent ? `${h.holderUserId}:${h.enrollmentId}` : `${h.holderUserId}`;
    const existingActiveId = activeCardMap.get(activeKey);
    if (existingActiveId) {
      failed.push({
        holderUserId: h.holderUserId,
        error: "This holder already has an active ID card. Delete the existing card before generating a new one.",
        code: "ACTIVE_CARD_EXISTS",
        existingCardId: existingActiveId,
      });
      continue;
    }

    const details = isStudent ? studentSnapshots!.get(h.enrollmentId!) : staffSnapshots!.get(h.holderUserId);
    if (isStudent && !details) {
      failed.push({ holderUserId: h.holderUserId, error: "Enrollment not found for this student — cannot issue card" });
      continue;
    }

    // Dedup card numbers WITHIN this batch — with random 6-digit suffixes,
    // a large single batch has a non-trivial birthday-paradox collision
    // chance if left unchecked. Regenerating on collision is essentially
    // free (no DB call) and eliminates the main source of collisions.
    let cardNumber = generateCardNumber(schoolShortCode);
    while (usedCardNumbers.has(cardNumber)) {
      cardNumber = generateCardNumber(schoolShortCode);
    }
    usedCardNumbers.add(cardNumber);

    insertValues.push({
      holderType,
      holderUserId: h.holderUserId,
      enrollmentId: isStudent ? h.enrollmentId : null,
      templateId,
      cardNumber,
      verificationToken: generateVerificationToken(),
      holderNameSnapshot: user.name,
      photoUrlSnapshot: user.avatarUrl || null,
      detailsSnapshot: JSON.stringify(details || {}),
      validUntil,
      status: IdCardStatus.ACTIVE,
      issuedBy,
    });
    rowMeta.push({ holderUserId: h.holderUserId });
  }

  if (insertValues.length === 0) return { succeeded: [], failed };

  // ── 7. ONE batched multi-row INSERT instead of N sequential inserts ──────
  // Falls back to per-row inserts ONLY if the batch statement itself fails
  // (e.g. a rare cross-batch cardNumber collision against an already-issued
  // card) — so a single bad row can't silently lose the whole batch.
  let succeeded: number[] = [];
  try {
    const inserted = await db
      .insert(idCardsSchema)
      .values(insertValues)
      .returning({ id: idCardsSchema.id })
      .all();
    succeeded = inserted.map((r: any) => r.id);
  } catch {
    for (let i = 0; i < insertValues.length; i++) {
      try {
        const inserted = await db
          .insert(idCardsSchema)
          .values(insertValues[i])
          .returning({ id: idCardsSchema.id })
          .get();
        succeeded.push(inserted.id);
      } catch (rowErr: any) {
        failed.push({ holderUserId: rowMeta[i].holderUserId, error: rowErr.message || "Failed to insert card" });
      }
    }
  }

  return { succeeded, failed };
}

// ── Batched snapshot builders — same field mapping as buildStudentSnapshot /
// buildStaffSnapshot, but joined/filtered with inArray so they run ONCE for
// the whole batch instead of once per holder. ────────────────────────────────

async function batchBuildStudentSnapshots(
  db: any,
  enrollmentIds: number[]
): Promise<Map<number, IdCardDetailsSnapshot>> {
  const map = new Map<number, IdCardDetailsSnapshot>();
  if (enrollmentIds.length === 0) return map;

  const rows = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      admissionNumber: studentsSchema.admissionNumber,
      bloodGroup: schoolUsersSchema.bloodGroup,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolClassSectionsSchema.id, schoolStudentEnrollmentsSchema.classSectionId)
    )
    .innerJoin(schoolClassesSchema, eq(schoolClassesSchema.id, schoolClassSectionsSchema.classId))
    .innerJoin(schoolSectionsSchema, eq(schoolSectionsSchema.id, schoolClassSectionsSchema.sectionId))
    .innerJoin(studentsSchema, eq(studentsSchema.userId, schoolStudentEnrollmentsSchema.studentId))
    .innerJoin(schoolUsersSchema, eq(schoolUsersSchema.id, schoolStudentEnrollmentsSchema.studentId))
    .where(inArray(schoolStudentEnrollmentsSchema.id, enrollmentIds))
    .all();

  for (const row of rows) {
    map.set(row.enrollmentId, {
      className: row.className,
      sectionName: row.sectionName,
      rollNumber: row.rollNumber ?? undefined,
      admissionNumber: row.admissionNumber ?? undefined,
      bloodGroup: row.bloodGroup || undefined,
      dateOfBirth: row.dateOfBirth || undefined,
    });
  }
  return map;
}

async function batchBuildStaffSnapshots(
  db: any,
  holderUserIds: number[]
): Promise<Map<number, IdCardDetailsSnapshot>> {
  const users = await db
    .select({ id: schoolUsersSchema.id, bloodGroup: schoolUsersSchema.bloodGroup, dateOfBirth: schoolUsersSchema.dateOfBirth })
    .from(schoolUsersSchema)
    .where(inArray(schoolUsersSchema.id, holderUserIds))
    .all();
  // FIX: explicit generics on every Map() built from a .map() tuple —
  // same root cause as userMap above.
  const userMap = new Map<number, { id: number; bloodGroup: string | null; dateOfBirth: string | null }>(
    users.map((u: any) => [u.id, u])
  );

  const staffRows = await db
    .select({ userId: staffSchema.userId, designation: staffSchema.designation, department: staffSchema.department })
    .from(staffSchema)
    .where(inArray(staffSchema.userId, holderUserIds))
    .all();
  const staffMap = new Map<number, { userId: number; designation: string; department: string | null }>(
    staffRows.map((r: any) => [r.userId, r])
  );

  const missing = holderUserIds.filter((id) => !staffMap.has(id));
  let teacherMap = new Map<number, { userId: number; specialization: string | null }>();
  if (missing.length > 0) {
    const teacherRows = await db
      .select({ userId: teachersSchema.userId, specialization: teachersSchema.specialization })
      .from(teachersSchema)
      .where(inArray(teachersSchema.userId, missing))
      .all();
    teacherMap = new Map<number, { userId: number; specialization: string | null }>(
      teacherRows.map((r: any) => [r.userId, r])
    );
  }

  const result = new Map<number, IdCardDetailsSnapshot>();
  for (const id of holderUserIds) {
    const user = userMap.get(id);
    const staffRow = staffMap.get(id);
    if (staffRow) {
      result.set(id, {
        designation: staffRow.designation,
        department: staffRow.department ?? undefined,
        employeeCode: `EMP-${id}`,
        bloodGroup: user?.bloodGroup || undefined,
        dateOfBirth: user?.dateOfBirth || undefined,
      });
    } else {
      const teacherRow = teacherMap.get(id);
      result.set(id, {
        designation: "Teacher",
        department: teacherRow?.specialization ?? undefined,
        employeeCode: `EMP-${id}`,
        bloodGroup: user?.bloodGroup || undefined,
        dateOfBirth: user?.dateOfBirth || undefined,
      });
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — card data for rendering (single or bulk)
// ─────────────────────────────────────────────────────────────────────────────

export async function getIdCardData(
  db: any,
  cardIds: number[],
  schoolInfo: {
    name: string;
    shortName: string | null;
    logoUrl: string | null;
    tagline: string | null;
    addressLineOne: string;
    addressLineTwo: string;
    phone: string;
  },
  frontendVerifyBaseUrl: string,
  /** The school's uniqueCode (from the super DB schools table) — required
   *  in the verify URL so the public verify endpoint can resolve which
   *  per-school Turso DB to query, since verificationToken alone doesn't
   *  carry tenancy information across this app's per-school-DB model. */
  schoolUniqueCode: string
): Promise<IdCardData[]> {
  if (cardIds.length === 0) return [];

  const rows = await db
    .select({
      id: idCardsSchema.id,
      cardNumber: idCardsSchema.cardNumber,
      holderType: idCardsSchema.holderType,
      holderName: idCardsSchema.holderNameSnapshot,
      photoUrl: idCardsSchema.photoUrlSnapshot,
      detailsSnapshot: idCardsSchema.detailsSnapshot,
      issuedAt: idCardsSchema.issuedAt,
      validUntil: idCardsSchema.validUntil,
      status: idCardsSchema.status,
      verificationToken: idCardsSchema.verificationToken,
      templateId: idCardTemplatesSchema.id,
      templateName: idCardTemplatesSchema.name,
      templateLayoutConfig: idCardTemplatesSchema.layoutConfig,
    })
    .from(idCardsSchema)
    .innerJoin(
      idCardTemplatesSchema,
      eq(idCardTemplatesSchema.id, idCardsSchema.templateId)
    )
    .where(inArray(idCardsSchema.id, cardIds))
    .all();

  return rows.map((row: any) => ({
    id: row.id,
    cardNumber: row.cardNumber,
    holderType: row.holderType,
    holderName: row.holderName,
    photoUrl: row.photoUrl,
    details: JSON.parse(row.detailsSnapshot || "{}"),
    issuedAt: row.issuedAt,
    validUntil: row.validUntil,
    status: row.status,
    verificationUrl: `${frontendVerifyBaseUrl.replace(/\/$/, "")}/verify/${row.verificationToken
      }?school=${encodeURIComponent(schoolUniqueCode)}`,
    template: {
      id: row.templateId,
      name: row.templateName,
      layoutConfig: JSON.parse(row.templateLayoutConfig || "{}"),
    },
    school: schoolInfo,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// REVOKE
// ─────────────────────────────────────────────────────────────────────────────

export async function revokeIdCard(
  db: any,
  cardId: number,
  revokedBy: number,
  reason: string
): Promise<void> {
  const card = await db
    .select()
    .from(idCardsSchema)
    .where(eq(idCardsSchema.id, cardId))
    .get();
  if (!card) throw new Error("Card not found");
  if (card.status !== IdCardStatus.ACTIVE) {
    throw new Error(`Cannot revoke a card with status ${card.status}`);
  }

  await db
    .update(idCardsSchema)
    .set({
      status: IdCardStatus.REVOKED,
      revokedAt: new Date().toISOString(),
      revokedBy,
      revokedReason: reason,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(idCardsSchema.id, cardId));
}

// ─────────────────────────────────────────────────────────────────────────────
// REISSUE — creates a new ACTIVE card, marks the old one REISSUED, links them
// ─────────────────────────────────────────────────────────────────────────────

export async function reissueIdCard(
  db: any,
  schoolShortCode: string,
  oldCardId: number,
  issuedBy: number,
  overrides?: { templateId?: number; validUntil?: string }
): Promise<{ id: number }> {
  const oldCard = await db
    .select()
    .from(idCardsSchema)
    .where(eq(idCardsSchema.id, oldCardId))
    .get();

  if (!oldCard) throw new Error("Card not found");

  const newCardNumber = generateCardNumber(schoolShortCode);
  const newToken = generateVerificationToken();

  const result = await db.transaction(async (tx: any) => {
    const inserted = await tx
      .insert(idCardsSchema)
      .values({
        holderType: oldCard.holderType,
        holderUserId: oldCard.holderUserId,
        enrollmentId: oldCard.enrollmentId,
        templateId: overrides?.templateId ?? oldCard.templateId,
        cardNumber: newCardNumber,
        verificationToken: newToken,
        holderNameSnapshot: oldCard.holderNameSnapshot,
        photoUrlSnapshot: oldCard.photoUrlSnapshot,
        detailsSnapshot: oldCard.detailsSnapshot,
        validUntil: overrides?.validUntil ?? oldCard.validUntil,
        status: IdCardStatus.ACTIVE,
        issuedBy,
      })
      .returning({ id: idCardsSchema.id })
      .get();

    await tx
      .update(idCardsSchema)
      .set({
        status: IdCardStatus.REISSUED,
        reissuedAsCardId: inserted.id,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(idCardsSchema.id, oldCardId));

    return inserted;
  });

  return { id: result.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — permanent removal. Distinct from revokeIdCard(), which only flips
// status and preserves the row for audit history. This is a real DELETE,
// used to satisfy the "one card per holder" rule: an admin who wants a fresh
// card for a holder that already has one must delete the old row first.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteIdCard(db: any, cardId: number): Promise<void> {
  const card = await db
    .select({ id: idCardsSchema.id })
    .from(idCardsSchema)
    .where(eq(idCardsSchema.id, cardId))
    .get();

  if (!card) {
    throw new Error("Card not found");
  }

  await db.transaction(async (tx: any) => {
    // Defensive: if this card is the "new" side of a past reissue (an older
    // REISSUED card points to it via reissuedAsCardId), null that pointer
    // first so no row is left referencing a deleted id.
    await tx
      .update(idCardsSchema)
      .set({ reissuedAsCardId: null })
      .where(eq(idCardsSchema.reissuedAsCardId, cardId));

    await tx.delete(idCardsSchema).where(eq(idCardsSchema.id, cardId));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — BULK. Same permanent-removal semantics as deleteIdCard(), but for
// a whole selection at once (id-card-management table's "Delete Selected").
// Runs as a single transaction: either every found card is deleted, or none
// are (a mid-batch failure — e.g. a transient DB error — should not leave
// half the selection deleted and half not).
// ─────────────────────────────────────────────────────────────────────────────

export interface DeleteBulkResult {
  deletedCount: number;
  deletedIds: number[];
  /** IDs the caller asked to delete but that no longer exist — e.g. someone
   *  else deleted them a moment earlier. Not an error; just reported back so
   *  the frontend can reconcile its selection state. */
  notFound: number[];
}

export async function deleteIdCardsBulk(
  db: any,
  cardIds: number[]
): Promise<DeleteBulkResult> {
  const uniqueIds = Array.from(new Set(cardIds));
  if (uniqueIds.length === 0) {
    return { deletedCount: 0, deletedIds: [], notFound: [] };
  }

  const existing = await db
    .select({ id: idCardsSchema.id })
    .from(idCardsSchema)
    .where(inArray(idCardsSchema.id, uniqueIds))
    .all();

  const existingIds: number[] = existing.map((r: any) => r.id);
  const existingIdSet = new Set(existingIds);
  const notFound = uniqueIds.filter((id) => !existingIdSet.has(id));

  if (existingIds.length === 0) {
    return { deletedCount: 0, deletedIds: [], notFound };
  }

  await db.transaction(async (tx: any) => {
    // Same defensive step as the single-delete path, batched: null out any
    // reissuedAsCardId pointers from older cards that point at rows we're
    // about to delete, so nothing is left referencing a deleted id.
    await tx
      .update(idCardsSchema)
      .set({ reissuedAsCardId: null })
      .where(inArray(idCardsSchema.reissuedAsCardId, existingIds));

    await tx.delete(idCardsSchema).where(inArray(idCardsSchema.id, existingIds));
  });

  return { deletedCount: existingIds.length, deletedIds: existingIds, notFound };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC VERIFY — minimal sanitized payload, no internal IDs exposed
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  status: "ACTIVE" | "REVOKED" | "EXPIRED" | "REISSUED" | "NOT_FOUND";
  holderName?: string;
  holderType?: IdCardHolderTypeValue;
  photoUrl?: string | null;
  roleLabel?: string; // e.g. "Class 8 - A | Roll No. 12" or "Teacher, Science Dept."
  schoolName?: string;
  validUntil?: string;
  cardNumber?: string;
}

export async function verifyIdCardToken(
  db: any,
  token: string
): Promise<VerifyResult> {
  const card = await db
    .select({
      cardNumber: idCardsSchema.cardNumber,
      holderType: idCardsSchema.holderType,
      holderName: idCardsSchema.holderNameSnapshot,
      photoUrl: idCardsSchema.photoUrlSnapshot,
      detailsSnapshot: idCardsSchema.detailsSnapshot,
      validUntil: idCardsSchema.validUntil,
      status: idCardsSchema.status,
    })
    .from(idCardsSchema)
    .where(eq(idCardsSchema.verificationToken, token))
    .get();

  if (!card) {
    return { valid: false, status: "NOT_FOUND" };
  }

  // Lazily evaluate expiry rather than relying solely on the persisted
  // status — a card can pass validUntil before any background job updates
  // its row, and the public verify endpoint must never report a stale
  // ACTIVE status for an expired card.
  const isPastValidity = new Date(card.validUntil) < new Date();
  const effectiveStatus =
    isPastValidity && card.status === IdCardStatus.ACTIVE
      ? IdCardStatus.EXPIRED
      : card.status;

  const details: IdCardDetailsSnapshot = JSON.parse(
    card.detailsSnapshot || "{}"
  );
  const roleLabel =
    card.holderType === "STUDENT"
      ? [
        details.className && details.sectionName
          ? `${details.className} - ${details.sectionName}`
          : null,
        details.rollNumber ? `Roll No. ${details.rollNumber}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
      : [details.designation, details.department].filter(Boolean).join(", ");

  return {
    valid: effectiveStatus === IdCardStatus.ACTIVE,
    status: effectiveStatus as VerifyResult["status"],
    holderName: card.holderName,
    holderType: card.holderType,
    photoUrl: card.photoUrl,
    roleLabel,
    validUntil: card.validUntil,
    cardNumber: card.cardNumber,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE-CARD UNIQUENESS GUARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Looks up the current ACTIVE card for a holder, scoped exactly the way
 * getEligibleHolders() scopes "already has a card":
 *   - STUDENT → unique per (holderUserId, enrollmentId). A student who is
 *     re-enrolled into a new class-section (new enrollmentId) is eligible
 *     for a fresh card even if an older enrollment still has one — that
 *     older card belongs to a class-section they've left.
 *   - STAFF   → unique per holderUserId (no enrollmentId concept).
 */
async function findActiveCardForHolder(
  db: any,
  holderType: IdCardHolderTypeValue,
  holderUserId: number,
  enrollmentId?: number
): Promise<{ id: number } | null> {
  const conditions = [
    eq(idCardsSchema.holderType, holderType),
    eq(idCardsSchema.holderUserId, holderUserId),
    eq(idCardsSchema.status, IdCardStatus.ACTIVE),
  ];
  if (holderType === "STUDENT" && enrollmentId != null) {
    conditions.push(eq(idCardsSchema.enrollmentId, enrollmentId));
  }

  const row = await db
    .select({ id: idCardsSchema.id })
    .from(idCardsSchema)
    .where(and(...conditions))
    .get();

  return row ?? null;
}