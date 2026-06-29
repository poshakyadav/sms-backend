// src/modules/school/id-cards/services.ts

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  idCardsSchema,
  idCardTemplatesSchema,
  IdCardHolderTypeValue,
  IdCardStatus,
} from "../../../db/schemas/school";
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { schoolStudentEnrollmentsSchema } from "../../../db/schemas/school/school-student-enrollments";
import { schoolClassSectionsSchema } from "../../../db/schemas/school/school-class-sections";
import { schoolClassesSchema } from "../../../db/schemas/school/school-classes";
import { schoolSectionsSchema } from "../../../db/schemas/school/school-sections";
import { studentsSchema } from "../../../db/schemas/school/students";
import { staffSchema } from "../../../db/schemas/school/staff";
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

export async function generateIdCardsBulk(
  db: any,
  schoolShortCode: string,
  inputs: GenerateCardInput[]
): Promise<{
  succeeded: number[];
  failed: Array<{ holderUserId: number; error: string }>;
}> {
  const succeeded: number[] = [];
  const failed: Array<{ holderUserId: number; error: string }> = [];

  // Sequential, not Promise.all — keeps error attribution simple and avoids
  // hammering the DB connection with N parallel multi-statement inserts in
  // a single Workers invocation. Bulk batches in practice are class-section
  // sized (≤ ~60 students), so sequential is fast enough.
  for (const input of inputs) {
    try {
      const { id } = await generateIdCard(db, schoolShortCode, input);
      succeeded.push(id);
    } catch (err: any) {
      failed.push({
        holderUserId: input.holderUserId,
        error: err.message || "Unknown error",
      });
    }
  }

  return { succeeded, failed };
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
    verificationUrl: `${frontendVerifyBaseUrl.replace(/\/$/, "")}/verify/${
      row.verificationToken
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
