// src/modules/school/fees/services.ts

import { getSchoolDB } from "../../../db/school-client";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolSectionsSchema,
  schoolsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
  studentsSchema,
} from "../../../db/schemas/school";
import { schoolFeeConcessionsSchema } from "../../../db/schemas/school/school-fee-concessions";
import { schoolStudentFeeAssignmentsSchema } from "../../../db/schemas/school/school-student-fee-assignments";
import { SchoolEnv } from "../../../types/common-types";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { sendTransactionalEmail } from "../../../utils/sendEmail";

// ─────────────────────────────────────────────────────────────────────────────
// CONCESSION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the effective (discounted) amount for a fee structure given an
 * active concession.
 * INVARIANT: Discount can never exceed the original amount (result >= 0).
 */
function applyDiscount(
  originalAmount: number,
  concession: {
    concessionType: "PERCENTAGE" | "FIXED";
    concessionValue: number;
  } | null
): number {
  if (!concession) return originalAmount;
  if (concession.concessionType === "FIXED") {
    return Math.max(0, originalAmount - concession.concessionValue);
  }
  // PERCENTAGE — floor to avoid fractional paise
  // NOTE: Math.floor is correct here — we always round down in favour of the
  // school to avoid floating-point disputes over sub-paise amounts.
  const discount = Math.floor(
    (originalAmount * concession.concessionValue) / 100
  );
  return Math.max(0, originalAmount - discount);
}

/**
 * Fetches ACTIVE concessions for a given enrollment, keyed by feeStructureId.
 * Returns a Map<feeStructureId, concession> for O(1) lookup.
 *
 * Accepts either a plain db instance OR a Drizzle transaction (tx).
 */
async function getConcessionsForEnrollment(
  db: any,
  enrollmentId: number
): Promise<
  Map<
    number,
    {
      concessionType: "PERCENTAGE" | "FIXED";
      concessionValue: number;
      reason: string;
      id: number;
    }
  >
> {
  const concessions = await db
    .select({
      id: schoolFeeConcessionsSchema.id,
      feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
    })
    .from(schoolFeeConcessionsSchema)
    .where(
      and(
        eq(schoolFeeConcessionsSchema.enrollmentId, enrollmentId),
        eq(schoolFeeConcessionsSchema.isActive, true)
      )
    )
    .all();

  return new Map(concessions.map((c: any) => [c.feeStructureId, c]));
}

// ─────────────────────────────────────────────────────────────────────────────
// FEE ASSIGNMENT CONCESSION HELPERS  (NEW — Gap 3 fix)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches ACTIVE assignment-level concessions for a given enrollment,
 * keyed by studentFeeAssignmentId.
 *
 * This is the parallel of getConcessionsForEnrollment() but for
 * student_fee_assignments (transport, hostel, custom) rather than
 * class-section fee_structures.
 *
 * Returns a Map<assignmentId, concession> for O(1) lookup.
 */
async function getAssignmentConcessionsForEnrollment(
  db: any,
  enrollmentId: number
): Promise<
  Map<
    number,
    {
      concessionType: "PERCENTAGE" | "FIXED";
      concessionValue: number;
      reason: string;
      id: number;
    }
  >
> {
  const concessions = await db
    .select({
      id: schoolFeeConcessionsSchema.id,
      assignmentId: schoolFeeConcessionsSchema.studentFeeAssignmentId,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
    })
    .from(schoolFeeConcessionsSchema)
    .where(
      and(
        eq(schoolFeeConcessionsSchema.enrollmentId, enrollmentId),
        eq(schoolFeeConcessionsSchema.isActive, true),
        // Only assignment-level concessions (feeStructureId IS NULL)
        sql`${schoolFeeConcessionsSchema.feeStructureId} IS NULL`,
        sql`${schoolFeeConcessionsSchema.studentFeeAssignmentId} IS NOT NULL`
      )
    )
    .all();

  return new Map(concessions.map((c: any) => [c.assignmentId, c]));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCESSION CRUD
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateConcessionInput {
  enrollmentId: number;
  feeStructureId?: number;
  // NEW: assignment-level concession target
  studentFeeAssignmentId?: number;
  concessionType: "PERCENTAGE" | "FIXED";
  concessionValue: number;
  reason: string;
  approvedBy: number;
}

export async function createConcession(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: CreateConcessionInput
) {
  // Exactly one of feeStructureId / studentFeeAssignmentId must be provided
  if (!data.feeStructureId && !data.studentFeeAssignmentId) {
    throw new Error(
      "Provide either feeStructureId or studentFeeAssignmentId — not both, not neither."
    );
  }
  if (data.feeStructureId && data.studentFeeAssignmentId) {
    throw new Error(
      "Provide either feeStructureId or studentFeeAssignmentId — not both."
    );
  }

  const db = await getSchoolDB(env, schoolCode);

  // ── Resolve the base amount from whichever source was given ────────────────
  let baseAmount: number;

  if (data.feeStructureId) {
    const feeStructure = await db
      .select({ amount: schoolFeeStructuresSchema.amount })
      .from(schoolFeeStructuresSchema)
      .where(eq(schoolFeeStructuresSchema.id, data.feeStructureId))
      .get();

    if (!feeStructure) throw new Error("Fee structure not found");
    baseAmount = feeStructure.amount;
  } else {
    // studentFeeAssignmentId branch
    const assignment = await db
      .select({
        amount: schoolStudentFeeAssignmentsSchema.amount,
        isCancelled: schoolStudentFeeAssignmentsSchema.isCancelled,
      })
      .from(schoolStudentFeeAssignmentsSchema)
      .where(
        eq(schoolStudentFeeAssignmentsSchema.id, data.studentFeeAssignmentId!)
      )
      .get();

    if (!assignment) throw new Error("Fee assignment not found");
    if (assignment.isCancelled)
      throw new Error(
        "Cannot apply a concession to a cancelled fee assignment"
      );
    baseAmount = assignment.amount;
  }

  // ── Value range validation ─────────────────────────────────────────────────
  if (data.concessionType === "PERCENTAGE") {
    if (data.concessionValue < 1 || data.concessionValue > 100) {
      throw new Error("Percentage concession must be between 1 and 100");
    }
  } else {
    if (data.concessionValue <= 0)
      throw new Error("Fixed concession amount must be positive");
    if (data.concessionValue > baseAmount) {
      throw new Error(
        `Fixed concession (₹${data.concessionValue / 100}) cannot exceed ` +
          `fee amount (₹${baseAmount / 100})`
      );
    }
  }

  // ── Duplicate active concession guard ─────────────────────────────────────
  const duplicateConditions = data.feeStructureId
    ? and(
        eq(schoolFeeConcessionsSchema.enrollmentId, data.enrollmentId),
        eq(schoolFeeConcessionsSchema.feeStructureId, data.feeStructureId),
        eq(schoolFeeConcessionsSchema.isActive, true)
      )
    : and(
        eq(schoolFeeConcessionsSchema.enrollmentId, data.enrollmentId),
        eq(
          schoolFeeConcessionsSchema.studentFeeAssignmentId,
          data.studentFeeAssignmentId!
        ),
        eq(schoolFeeConcessionsSchema.isActive, true)
      );

  const existing = await db
    .select({ id: schoolFeeConcessionsSchema.id })
    .from(schoolFeeConcessionsSchema)
    .where(duplicateConditions)
    .get();

  if (existing) {
    throw new Error(
      "An active concession already exists for this fee. Revoke it first, " +
        "then create a new one."
    );
  }

  // ── Insert ─────────────────────────────────────────────────────────────────
  const [newConcession] = await db
    .insert(schoolFeeConcessionsSchema)
    .values({
      enrollmentId: data.enrollmentId,
      feeStructureId: data.feeStructureId ?? null,
      studentFeeAssignmentId: data.studentFeeAssignmentId ?? null,
      concessionType: data.concessionType,
      concessionValue: data.concessionValue,
      reason: data.reason,
      approvedBy: data.approvedBy,
      isActive: true,
    })
    .returning();

  const effectiveAmount = applyDiscount(baseAmount, {
    concessionType: data.concessionType,
    concessionValue: data.concessionValue,
  });
  const discountAmount = baseAmount - effectiveAmount;

  return {
    concession: newConcession,
    originalAmount: baseAmount,
    discountAmount,
    effectiveAmount,
    message: "Concession granted successfully",
  };
}

export async function revokeConcession(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  concessionId: number,
  revokedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolFeeConcessionsSchema)
    .set({
      isActive: false,
      revokedAt: new Date().toISOString(),
      revokedBy,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(schoolFeeConcessionsSchema.id, concessionId),
        eq(schoolFeeConcessionsSchema.isActive, true) // can only revoke active ones
      )
    )
    .returning();

  if (!updated) throw new Error("Concession not found or already revoked");
  return { message: "Concession revoked successfully", concession: updated };
}

export async function getConcessionsForStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Fee-structure-level concessions ───────────────────────────────────────
  const structureConcessions = await db
    .select({
      id: schoolFeeConcessionsSchema.id,
      source: sql<string>`'STRUCTURE'`,
      feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
      studentFeeAssignmentId: sql<null>`NULL`,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      originalAmount: schoolFeeStructuresSchema.amount,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
      isActive: schoolFeeConcessionsSchema.isActive,
      revokedAt: schoolFeeConcessionsSchema.revokedAt,
      createdAt: schoolFeeConcessionsSchema.createdAt,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolFeeStructuresSchema,
      eq(
        schoolFeeConcessionsSchema.feeStructureId,
        schoolFeeStructuresSchema.id
      )
    )
    .where(
      and(
        eq(schoolFeeConcessionsSchema.enrollmentId, enrollmentId),
        sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`
      )
    )
    .orderBy(desc(schoolFeeConcessionsSchema.createdAt))
    .all();

  // ── Assignment-level concessions ──────────────────────────────────────────
  const assignmentConcessions = await db
    .select({
      id: schoolFeeConcessionsSchema.id,
      source: sql<string>`'ASSIGNMENT'`,
      feeStructureId: sql<null>`NULL`,
      studentFeeAssignmentId: schoolFeeConcessionsSchema.studentFeeAssignmentId,
      feeType: schoolStudentFeeAssignmentsSchema.feeType,
      feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
      originalAmount: schoolStudentFeeAssignmentsSchema.amount,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
      isActive: schoolFeeConcessionsSchema.isActive,
      revokedAt: schoolFeeConcessionsSchema.revokedAt,
      createdAt: schoolFeeConcessionsSchema.createdAt,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolStudentFeeAssignmentsSchema,
      eq(
        schoolFeeConcessionsSchema.studentFeeAssignmentId,
        schoolStudentFeeAssignmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolFeeConcessionsSchema.enrollmentId, enrollmentId),
        sql`${schoolFeeConcessionsSchema.studentFeeAssignmentId} IS NOT NULL`
      )
    )
    .orderBy(desc(schoolFeeConcessionsSchema.createdAt))
    .all();

  const allConcessions = [
    ...structureConcessions,
    ...assignmentConcessions,
  ].sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));

  return allConcessions.map((c: any) => {
    const discountAmount =
      c.concessionType === "FIXED"
        ? c.concessionValue
        : Math.floor((c.originalAmount * c.concessionValue) / 100);
    return {
      ...c,
      discountAmount,
      effectiveAmount: Math.max(0, c.originalAmount - discountAmount),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT FEE ASSIGNMENTS (Transport / Hostel / Custom)
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateStudentFeeAssignmentInput {
  enrollmentId: number;
  academicYearId: number;
  feeType: string;
  amount: number;
  feeMonth?: string | null;
  dueDate?: string | null;
  description?: string | null;
  isMandatory?: boolean;
  assignedBy: number;
}

export async function createStudentFeeAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: CreateStudentFeeAssignmentInput
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.id, data.enrollmentId))
    .get();

  if (!enrollment) throw new Error("Enrollment not found");
  if (data.amount <= 0) throw new Error("Fee amount must be positive");

  if (data.feeMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.feeMonth)) {
    throw new Error("feeMonth must be in YYYY-MM format (e.g. 2025-04)");
  }

  const [assignment] = await db
    .insert(schoolStudentFeeAssignmentsSchema)
    .values({
      enrollmentId: data.enrollmentId,
      academicYearId: data.academicYearId,
      feeType: data.feeType,
      amount: data.amount,
      feeMonth: data.feeMonth ?? null,
      dueDate: data.dueDate ?? null,
      description: data.description ?? null,
      isMandatory: data.isMandatory ?? true,
      assignedBy: data.assignedBy,
      isCancelled: false,
    })
    .returning();

  return { assignment, message: "Fee assignment created successfully" };
}

export interface BulkMonthlyAssignmentInput {
  enrollmentId: number;
  academicYearId: number;
  feeType: string;
  amount: number;
  startMonth: string;
  endMonth: string;
  dueDayOfMonth?: number;
  description?: string | null;
  assignedBy: number;
}

export async function createBulkMonthlyAssignments(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: BulkMonthlyAssignmentInput
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.id, data.enrollmentId))
    .get();
  if (!enrollment) throw new Error("Enrollment not found");

  const months = generateMonthRange(data.startMonth, data.endMonth);
  if (months.length === 0) throw new Error("No months in range");

  // ── FIX (Bug 2): Full-range duplicate detection ───────────────────────────
  // Check ALL months in the range, not just months[0].
  // Prevents silent overlap when a second bulk call covers a subset of an
  // already-created range (e.g. April–March then June–December).
  const existingCheck = await db
    .select({ id: schoolStudentFeeAssignmentsSchema.id })
    .from(schoolStudentFeeAssignmentsSchema)
    .where(
      and(
        eq(schoolStudentFeeAssignmentsSchema.enrollmentId, data.enrollmentId),
        eq(schoolStudentFeeAssignmentsSchema.feeType, data.feeType),
        inArray(schoolStudentFeeAssignmentsSchema.feeMonth, months),
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
      )
    )
    .get();

  if (existingCheck) {
    throw new Error(
      `Active ${data.feeType} assignments already exist for one or more months ` +
        `in the range ${data.startMonth}–${data.endMonth} for this enrollment. ` +
        `Cancel existing assignments first.`
    );
  }

  const rows = months.map((feeMonth) => {
    let dueDate: string | null = null;
    if (data.dueDayOfMonth) {
      const [my, mm] = feeMonth.split("-");
      dueDate = `${my}-${mm}-${String(data.dueDayOfMonth).padStart(2, "0")}`;
    }
    return {
      enrollmentId: data.enrollmentId,
      academicYearId: data.academicYearId,
      feeType: data.feeType,
      amount: data.amount,
      feeMonth,
      dueDate,
      description: data.description ?? null,
      isMandatory: true,
      assignedBy: data.assignedBy,
      isCancelled: false,
    };
  });

  const inserted = await db
    .insert(schoolStudentFeeAssignmentsSchema)
    .values(rows)
    .returning();

  return {
    assignments: inserted,
    monthCount: inserted.length,
    message: `${inserted.length} monthly fee assignments created`,
  };
}

export async function cancelStudentFeeAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  assignmentId: number,
  cancelledBy: number,
  reason: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolStudentFeeAssignmentsSchema)
    .set({
      isCancelled: true,
      cancelledAt: new Date().toISOString(),
      cancelledBy,
      cancellationReason: reason,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(schoolStudentFeeAssignmentsSchema.id, assignmentId),
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false) // idempotency guard
      )
    )
    .returning();

  if (!updated)
    throw new Error("Fee assignment not found or already cancelled");
  return { message: "Fee assignment cancelled", assignment: updated };
}

export async function getStudentFeeAssignments(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number,
  includeOnlyActive: boolean = true
) {
  const db = await getSchoolDB(env, schoolCode);

  const conditions = [
    eq(schoolStudentFeeAssignmentsSchema.enrollmentId, enrollmentId),
  ];
  if (includeOnlyActive) {
    conditions.push(eq(schoolStudentFeeAssignmentsSchema.isCancelled, false));
  }

  const assignments = await db
    .select()
    .from(schoolStudentFeeAssignmentsSchema)
    .where(and(...conditions))
    .orderBy(
      schoolStudentFeeAssignmentsSchema.feeMonth,
      schoolStudentFeeAssignmentsSchema.feeType
    )
    .all();

  if (assignments.length === 0) return [];

  const assignmentIds = assignments.map((a: any) => a.id);

  const paymentRows = await db
    .select({
      studentFeeAssignmentId: schoolFeePaymentsSchema.studentFeeAssignmentId,
      totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        inArray(schoolFeePaymentsSchema.studentFeeAssignmentId, assignmentIds),
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(schoolFeePaymentsSchema.studentFeeAssignmentId)
    .all();

  const paidMap = new Map<number, number>(
    paymentRows.map((r: any) => [r.studentFeeAssignmentId, r.totalPaid])
  );

  // ── FIX (Gap 3): Fetch assignment-level concessions ───────────────────────
  const assignmentConcessionMap = await getAssignmentConcessionsForEnrollment(
    db,
    enrollmentId
  );

  const today = new Date().toISOString().split("T")[0];

  return assignments.map((a: any) => {
    const concession = assignmentConcessionMap.get(a.id) ?? null;
    const concessionAmount = concession
      ? concession.concessionType === "FIXED"
        ? concession.concessionValue
        : Math.floor((a.amount * concession.concessionValue) / 100)
      : 0;
    const effectiveAmount = Math.max(0, a.amount - concessionAmount);
    const amountPaid = paidMap.get(a.id) ?? 0;
    const balance = effectiveAmount - amountPaid;

    let status: "PAID" | "PARTIAL" | "PENDING" | "OVERDUE";
    if (balance <= 0) status = "PAID";
    else if (amountPaid > 0) status = "PARTIAL";
    else if (a.dueDate && a.dueDate < today) status = "OVERDUE";
    else status = "PENDING";

    return {
      ...a,
      concessionAmount,
      concessionReason: concession?.reason ?? null,
      effectiveAmount,
      amountPaid,
      balance,
      status,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK MONTHLY FEE STRUCTURES (class-section level, month-wise)
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkMonthlyFeeStructureInput {
  academicYearId: number;
  classSectionId: number;
  feeType: string;
  amount: number;
  startMonth: string;
  endMonth: string;
  dueDayOfMonth?: number;
  description?: string | null;
  isMandatory?: boolean;
}

export async function createBulkMonthlyFeeStructures(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: BulkMonthlyFeeStructureInput
) {
  const db = await getSchoolDB(env, schoolCode);

  const months = generateMonthRange(data.startMonth, data.endMonth);
  if (months.length === 0) throw new Error("No months in range");

  // ── FIX (Bug 2): Full-range duplicate detection ───────────────────────────
  // Check ALL months in the requested range, not just months[0].
  // Prevents silent overlap when a second bulk call covers a subset of an
  // already-created range (e.g. April–March then June–December).
  const existingCheck = await db
    .select({ id: schoolFeeStructuresSchema.id })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, data.classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, data.academicYearId),
        eq(schoolFeeStructuresSchema.feeType, data.feeType),
        inArray(schoolFeeStructuresSchema.feeMonth, months)
      )
    )
    .get();

  if (existingCheck) {
    throw new Error(
      `Fee structures for ${data.feeType} already exist for one or more months ` +
        `in the range ${data.startMonth}–${data.endMonth} for this class-section. ` +
        `Delete existing structures first if you need to recreate them.`
    );
  }

  const rows = months.map((feeMonth) => {
    let dueDate: string | null = null;
    if (data.dueDayOfMonth) {
      const [my, mm] = feeMonth.split("-");
      dueDate = `${my}-${mm}-${String(data.dueDayOfMonth).padStart(2, "0")}`;
    }
    return {
      academicYearId: data.academicYearId,
      classSectionId: data.classSectionId,
      feeType: data.feeType,
      amount: data.amount,
      feeMonth,
      dueDate,
      description: data.description ?? null,
      isMandatory: data.isMandatory ?? true,
    };
  });

  const inserted = await db
    .insert(schoolFeeStructuresSchema)
    .values(rows)
    .returning();

  return {
    structures: inserted,
    monthCount: inserted.length,
    message: `${inserted.length} monthly fee structures created`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECORD FEE PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentItem {
  feeStructureId?: number;
  studentFeeAssignmentId?: number;
  amountPaid: number;
}

export async function recordFeePayment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    enrollmentId: number;
    paymentMethod: "CASH" | "CHECK" | "BANK_TRANSFER";
    notes?: string;
    feeStructureId?: number;
    amountPaid?: number;
    studentFeeAssignmentId?: number;
    payments?: PaymentItem[];
  },
  recordedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const paymentsToProcess: PaymentItem[] =
    data.payments && data.payments.length > 0
      ? data.payments
      : data.feeStructureId && data.amountPaid
      ? [{ feeStructureId: data.feeStructureId, amountPaid: data.amountPaid }]
      : data.studentFeeAssignmentId && data.amountPaid
      ? [
          {
            studentFeeAssignmentId: data.studentFeeAssignmentId,
            amountPaid: data.amountPaid,
          },
        ]
      : [];

  if (paymentsToProcess.length === 0)
    throw new Error("No payment data provided");

  for (const p of paymentsToProcess) {
    if (!p.feeStructureId && !p.studentFeeAssignmentId) {
      throw new Error(
        "Each payment must have either feeStructureId or studentFeeAssignmentId"
      );
    }
    if (p.feeStructureId && p.studentFeeAssignmentId) {
      throw new Error(
        "Each payment must have only ONE of feeStructureId or studentFeeAssignmentId"
      );
    }
  }

  // ── NEW: one batchId for every row this call inserts ─────────────────────
  // Stamped unconditionally (single-mode or multi-mode payments alike) so the
  // receipt-fetch logic never has to special-case "was this a batch or not."
  const batchId = crypto.randomUUID();

  return await db.transaction(async (tx: any) => {
    // 1. Verify enrollment
    const enrollment = await tx
      .select({
        id: schoolStudentEnrollmentsSchema.id,
        studentId: schoolStudentEnrollmentsSchema.studentId,
        classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
        isActive: schoolStudentEnrollmentsSchema.isActive,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.id, data.enrollmentId))
      .get();

    if (!enrollment) throw new Error("Enrollment not found");
    if (!enrollment.isActive)
      throw new Error("Cannot record payment for inactive enrollment");

    // Fetch structure-level concessions (inside tx)
    const concessionMap = await getConcessionsForEnrollment(
      tx,
      data.enrollmentId
    );

    // FIX (Gap 3): Also fetch assignment-level concessions inside the transaction
    const assignmentConcessionMap = await getAssignmentConcessionsForEnrollment(
      tx,
      data.enrollmentId
    );

    const insertedPayments: any[] = [];
    const receiptNumbers: string[] = [];

    for (const p of paymentsToProcess) {
      if (p.amountPaid <= 0) continue;

      let feeType = "";
      // ── NEW: capture feeMonth alongside feeType for receipt display ───────
      let feeMonth: string | null = null;

      if (p.feeStructureId) {
        const feeStructure = await tx
          .select({
            id: schoolFeeStructuresSchema.id,
            amount: schoolFeeStructuresSchema.amount,
            classSectionId: schoolFeeStructuresSchema.classSectionId,
            feeType: schoolFeeStructuresSchema.feeType,
            feeMonth: schoolFeeStructuresSchema.feeMonth, // ← NEW field in select
          })
          .from(schoolFeeStructuresSchema)
          .where(eq(schoolFeeStructuresSchema.id, p.feeStructureId))
          .get();

        if (!feeStructure)
          throw new Error(`Fee structure ${p.feeStructureId} not found`);
        if (feeStructure.classSectionId !== enrollment.classSectionId) {
          throw new Error(
            "Fee structure does not belong to this student's class-section"
          );
        }

        feeType = feeStructure.feeType;
        feeMonth = feeStructure.feeMonth ?? null; // ← NEW

        const concession = concessionMap.get(p.feeStructureId) ?? null;
        const effectiveAmount = applyDiscount(feeStructure.amount, concession);

        const alreadyPaidRow = await tx
          .select({
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              eq(schoolFeePaymentsSchema.enrollmentId, data.enrollmentId),
              eq(schoolFeePaymentsSchema.feeStructureId, p.feeStructureId),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .get();

        const alreadyPaid = alreadyPaidRow?.totalPaid ?? 0;
        const remainingBalance = effectiveAmount - alreadyPaid;

        if (p.amountPaid > remainingBalance) {
          const concessionDesc = concession
            ? concession.concessionType === "PERCENTAGE"
              ? `${concession.concessionValue}% discount`
              : `₹${(concession.concessionValue / 100).toFixed(2)} discount`
            : "no discount";
          throw new Error(
            `Payment ₹${(p.amountPaid / 100).toFixed(2)} exceeds remaining ` +
              `balance ₹${(remainingBalance / 100).toFixed(
                2
              )} for ${feeType}. ` +
              `Effective amount (after ${concessionDesc}): ` +
              `₹${(effectiveAmount / 100).toFixed(2)}, ` +
              `already paid: ₹${(alreadyPaid / 100).toFixed(2)}.`
          );
        }
      } else if (p.studentFeeAssignmentId) {
        const assignment = await tx
          .select({
            id: schoolStudentFeeAssignmentsSchema.id,
            amount: schoolStudentFeeAssignmentsSchema.amount,
            enrollmentId: schoolStudentFeeAssignmentsSchema.enrollmentId,
            feeType: schoolStudentFeeAssignmentsSchema.feeType,
            feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth, // ← NEW field
            isCancelled: schoolStudentFeeAssignmentsSchema.isCancelled,
          })
          .from(schoolStudentFeeAssignmentsSchema)
          .where(
            eq(schoolStudentFeeAssignmentsSchema.id, p.studentFeeAssignmentId)
          )
          .get();

        if (!assignment)
          throw new Error(
            `Fee assignment ${p.studentFeeAssignmentId} not found`
          );
        if (assignment.enrollmentId !== data.enrollmentId) {
          throw new Error("Fee assignment does not belong to this enrollment");
        }
        if (assignment.isCancelled)
          throw new Error("Cannot pay a cancelled fee assignment");

        feeType = assignment.feeType;
        feeMonth = assignment.feeMonth ?? null; // ← NEW

        const assignmentConcession =
          assignmentConcessionMap.get(p.studentFeeAssignmentId) ?? null;
        const effectiveAmount = applyDiscount(
          assignment.amount,
          assignmentConcession
        );

        // ── FIX: scope alreadyPaid to both studentFeeAssignmentId AND
        // enrollmentId for consistency with the structure-payment branch.
        // studentFeeAssignmentId alone is safe (it's unique per assignment)
        // but scoping to enrollmentId as well makes the query intent explicit
        // and guards against any future schema changes that might relax that.
        const alreadyPaidRow = await tx
          .select({
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              eq(
                schoolFeePaymentsSchema.studentFeeAssignmentId,
                p.studentFeeAssignmentId
              ),
              eq(schoolFeePaymentsSchema.enrollmentId, data.enrollmentId), // ← added
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .get();

        const alreadyPaid = alreadyPaidRow?.totalPaid ?? 0;
        const remainingBalance = effectiveAmount - alreadyPaid;

        if (p.amountPaid > remainingBalance) {
          const concessionDesc = assignmentConcession
            ? assignmentConcession.concessionType === "PERCENTAGE"
              ? `${assignmentConcession.concessionValue}% discount`
              : `₹${(assignmentConcession.concessionValue / 100).toFixed(
                  2
                )} discount`
            : "no discount";
          throw new Error(
            `Payment ₹${(p.amountPaid / 100).toFixed(2)} exceeds remaining ` +
              `balance ₹${(remainingBalance / 100).toFixed(
                2
              )} for ${feeType}. ` +
              `Effective amount (after ${concessionDesc}): ` +
              `₹${(effectiveAmount / 100).toFixed(2)}, ` +
              `already paid: ₹${(alreadyPaid / 100).toFixed(2)}.`
          );
        }
      }

      const receiptNumber = `REC-${nanoid(8).toUpperCase()}`;
      receiptNumbers.push(receiptNumber);

      const [newPayment] = await tx
        .insert(schoolFeePaymentsSchema)
        .values({
          enrollmentId: data.enrollmentId,
          feeStructureId: p.feeStructureId ?? null,
          studentFeeAssignmentId: p.studentFeeAssignmentId ?? null,
          amountPaid: p.amountPaid,
          paymentMethod: data.paymentMethod,
          notes: data.notes ?? null,
          receiptNumber,
          recordedBy,
          batchId, // ← NEW
        })
        .returning();

      insertedPayments.push({ ...newPayment, feeType, feeMonth }); // ← feeMonth added
    }

    if (insertedPayments.length === 0)
      throw new Error("No valid payments to process");

    const totalPaidNow = insertedPayments.reduce(
      (s: number, p: any) => s + p.amountPaid,
      0
    );

    // Send receipt email (non-blocking — never fails the transaction)
    const student = await tx
      .select({ name: schoolUsersSchema.name, email: schoolUsersSchema.email })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, enrollment.studentId))
      .get();

    if (student) {
      const paymentLines = insertedPayments
        .map(
          (p: any) =>
            `<li>${p.feeType}: ₹${(p.amountPaid / 100).toLocaleString(
              "en-IN"
            )} — Receipt: ${p.receiptNumber}</li>`
        )
        .join("");

      const emailData: BrevoSendEmailRequest = {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: student.email, name: student.name }],
        subject: `Fee Payment Receipt${
          insertedPayments.length > 1 ? "s" : ""
        } — ${receiptNumbers.join(", ")}`,
        htmlContent: `
          <h2>Fee Payment Receipt</h2>
          <p><strong>Total Amount Paid:</strong> ₹${(
            totalPaidNow / 100
          ).toLocaleString("en-IN")}</p>
          <p><strong>Payment Date:</strong> ${
            insertedPayments[0].paymentDate
          }</p>
          <p><strong>Method:</strong> ${data.paymentMethod}</p>
          <ul>${paymentLines}</ul>
          ${data.notes ? `<p><strong>Notes:</strong> ${data.notes}</p>` : ""}
        `,
      };
      sendTransactionalEmail(env, emailData).catch((err: any) =>
        console.error("Receipt email failed:", err)
      );
    }

    return {
      payment: insertedPayments[0],
      payments: insertedPayments,
      message: `${
        insertedPayments.length > 1 ? "Payments" : "Payment"
      } recorded and receipt sent`,
      meta: {
        receiptNumbers,
        totalPaid: totalPaidNow,
        paymentCount: insertedPayments.length,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VOID PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Voids a fee payment record.
 * The payment row is preserved for audit; isVoid is set to true.
 * All balance and collection calculations automatically exclude voided rows
 * because every query already filters on isVoid = false.
 *
 * Guard: fees.payments.record
 */
export async function voidFeePayment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  paymentId: number,
  voidedBy: number,
  reason: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const payment = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      isVoid: schoolFeePaymentsSchema.isVoid,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
    })
    .from(schoolFeePaymentsSchema)
    .where(eq(schoolFeePaymentsSchema.id, paymentId))
    .get();

  if (!payment) throw new Error("Payment not found");
  if (payment.isVoid) throw new Error("Payment is already voided");

  const [updated] = await db
    .update(schoolFeePaymentsSchema)
    .set({
      isVoid: true,
      notes: reason,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolFeePaymentsSchema.id, paymentId))
    .returning();

  return {
    message: "Payment voided successfully",
    payment: updated,
    voidedReceiptNumber: payment.receiptNumber,
    voidedAmount: payment.amountPaid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT OWN FEES (month-wise + concessions + custom assignments)
// ─────────────────────────────────────────────────────────────────────────────

export interface StudentFeeItem {
  id: number;
  source: "STRUCTURE" | "ASSIGNMENT";
  feeType: string;
  feeMonth: string | null;
  originalAmount: number;
  concessionAmount: number;
  effectiveAmount: number;
  concessionReason: string | null;
  dueDate: string | null;
  isMandatory: boolean;
  description: string | null;
  amountPaid: number;
  balance: number;
  status: "PAID" | "PARTIAL" | "PENDING" | "OVERDUE";
}

export interface StudentPaymentItem {
  id: number;
  paymentDate: string;
  amountPaid: number;
  paymentMethod: "CASH" | "CHECK" | "BANK_TRANSFER";
  receiptNumber: string;
  feeType: string;
  notes: string | null;
}

export interface StudentFeeOverview {
  academicYearId: number;
  academicYearName: string;
  className: string;
  sectionName: string;
  rollNumber: string | null;
  totalOriginal: number;
  totalConcession: number;
  totalDue: number;
  totalPaid: number;
  balance: number;
  collectionRate: number;
  feeBreakdown: StudentFeeItem[];
  recentPayments: StudentPaymentItem[];
}

export async function getStudentOwnFees(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentUserId: number,
  academicYearId?: number
): Promise<StudentFeeOverview[]> {
  const db = await getSchoolDB(env, schoolCode);

  const enrollments = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      academicYearName: schoolAcademicYearsSchema.name,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
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
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentUserId),
        eq(schoolStudentEnrollmentsSchema.isActive, true),
        academicYearId
          ? eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId)
          : undefined
      )
    )
    .orderBy(
      desc(schoolAcademicYearsSchema.isCurrent),
      schoolAcademicYearsSchema.name
    )
    .all();

  if (enrollments.length === 0) return [];

  const overviews: StudentFeeOverview[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const enrollment of enrollments) {
    const feeStructures = await db
      .select({
        id: schoolFeeStructuresSchema.id,
        feeType: schoolFeeStructuresSchema.feeType,
        amount: schoolFeeStructuresSchema.amount,
        feeMonth: schoolFeeStructuresSchema.feeMonth,
        dueDate: schoolFeeStructuresSchema.dueDate,
        isMandatory: schoolFeeStructuresSchema.isMandatory,
        description: schoolFeeStructuresSchema.description,
      })
      .from(schoolFeeStructuresSchema)
      .where(
        and(
          eq(
            schoolFeeStructuresSchema.classSectionId,
            enrollment.classSectionId
          ),
          eq(
            schoolFeeStructuresSchema.academicYearId,
            enrollment.academicYearId
          )
        )
      )
      .orderBy(
        schoolFeeStructuresSchema.feeMonth,
        schoolFeeStructuresSchema.feeType
      )
      .all();

    const concessionMap = await getConcessionsForEnrollment(
      db,
      enrollment.enrollmentId
    );

    // FIX (Gap 3): Fetch assignment-level concessions
    const assignmentConcessionMap = await getAssignmentConcessionsForEnrollment(
      db,
      enrollment.enrollmentId
    );

    const structurePayments = await db
      .select({
        feeStructureId: schoolFeePaymentsSchema.feeStructureId,
        amountPaid: schoolFeePaymentsSchema.amountPaid,
        id: schoolFeePaymentsSchema.id,
        paymentDate: schoolFeePaymentsSchema.paymentDate,
        paymentMethod: schoolFeePaymentsSchema.paymentMethod,
        receiptNumber: schoolFeePaymentsSchema.receiptNumber,
        notes: schoolFeePaymentsSchema.notes,
        feeType: schoolFeeStructuresSchema.feeType,
      })
      .from(schoolFeePaymentsSchema)
      .innerJoin(
        schoolFeeStructuresSchema,
        eq(schoolFeePaymentsSchema.feeStructureId, schoolFeeStructuresSchema.id)
      )
      .where(
        and(
          eq(schoolFeePaymentsSchema.enrollmentId, enrollment.enrollmentId),
          eq(schoolFeePaymentsSchema.isVoid, false),
          sql`${schoolFeePaymentsSchema.feeStructureId} IS NOT NULL`
        )
      )
      .orderBy(desc(schoolFeePaymentsSchema.paymentDate))
      .all();

    const assignments = await db
      .select({
        id: schoolStudentFeeAssignmentsSchema.id,
        feeType: schoolStudentFeeAssignmentsSchema.feeType,
        amount: schoolStudentFeeAssignmentsSchema.amount,
        feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
        dueDate: schoolStudentFeeAssignmentsSchema.dueDate,
        isMandatory: schoolStudentFeeAssignmentsSchema.isMandatory,
        description: schoolStudentFeeAssignmentsSchema.description,
      })
      .from(schoolStudentFeeAssignmentsSchema)
      .where(
        and(
          eq(
            schoolStudentFeeAssignmentsSchema.enrollmentId,
            enrollment.enrollmentId
          ),
          eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
        )
      )
      .orderBy(
        schoolStudentFeeAssignmentsSchema.feeMonth,
        schoolStudentFeeAssignmentsSchema.feeType
      )
      .all();

    const assignmentPayments =
      assignments.length > 0
        ? await db
            .select({
              studentFeeAssignmentId:
                schoolFeePaymentsSchema.studentFeeAssignmentId,
              amountPaid: schoolFeePaymentsSchema.amountPaid,
              id: schoolFeePaymentsSchema.id,
              paymentDate: schoolFeePaymentsSchema.paymentDate,
              paymentMethod: schoolFeePaymentsSchema.paymentMethod,
              receiptNumber: schoolFeePaymentsSchema.receiptNumber,
              notes: schoolFeePaymentsSchema.notes,
            })
            .from(schoolFeePaymentsSchema)
            .where(
              and(
                eq(
                  schoolFeePaymentsSchema.enrollmentId,
                  enrollment.enrollmentId
                ),
                eq(schoolFeePaymentsSchema.isVoid, false),
                sql`${schoolFeePaymentsSchema.studentFeeAssignmentId} IS NOT NULL`
              )
            )
            .orderBy(desc(schoolFeePaymentsSchema.paymentDate))
            .all()
        : [];

    const structurePaidMap = new Map<number, number>();
    structurePayments.forEach((p: any) => {
      if (p.feeStructureId) {
        structurePaidMap.set(
          p.feeStructureId,
          (structurePaidMap.get(p.feeStructureId) ?? 0) + p.amountPaid
        );
      }
    });

    const assignmentPaidMap = new Map<number, number>();
    assignmentPayments.forEach((p: any) => {
      if (p.studentFeeAssignmentId) {
        assignmentPaidMap.set(
          p.studentFeeAssignmentId,
          (assignmentPaidMap.get(p.studentFeeAssignmentId) ?? 0) + p.amountPaid
        );
      }
    });

    const feeBreakdown: StudentFeeItem[] = [];

    for (const fee of feeStructures) {
      const concession = concessionMap.get(fee.id) ?? null;
      const concessionAmount = concession
        ? concession.concessionType === "FIXED"
          ? concession.concessionValue
          : Math.floor((fee.amount * concession.concessionValue) / 100)
        : 0;
      const effectiveAmount = Math.max(0, fee.amount - concessionAmount);
      const amountPaid = structurePaidMap.get(fee.id) ?? 0;
      const balance = effectiveAmount - amountPaid;

      let status: StudentFeeItem["status"];
      if (balance <= 0) status = "PAID";
      else if (amountPaid > 0) status = "PARTIAL";
      else if (fee.dueDate && fee.dueDate < today) status = "OVERDUE";
      else status = "PENDING";

      feeBreakdown.push({
        id: fee.id,
        source: "STRUCTURE",
        feeType: fee.feeType,
        feeMonth: fee.feeMonth ?? null,
        originalAmount: fee.amount,
        concessionAmount,
        effectiveAmount,
        concessionReason: concession?.reason ?? null,
        dueDate: fee.dueDate ?? null,
        isMandatory: fee.isMandatory,
        description: fee.description ?? null,
        amountPaid,
        balance,
        status,
      });
    }

    // FIX (Gap 3): Apply assignment-level concessions when building breakdown
    for (const a of assignments) {
      const concession = assignmentConcessionMap.get(a.id) ?? null;
      const concessionAmount = concession
        ? concession.concessionType === "FIXED"
          ? concession.concessionValue
          : Math.floor((a.amount * concession.concessionValue) / 100)
        : 0;
      const effectiveAmount = Math.max(0, a.amount - concessionAmount);
      const amountPaid = assignmentPaidMap.get(a.id) ?? 0;
      const balance = effectiveAmount - amountPaid;

      let status: StudentFeeItem["status"];
      if (balance <= 0) status = "PAID";
      else if (amountPaid > 0) status = "PARTIAL";
      else if (a.dueDate && a.dueDate < today) status = "OVERDUE";
      else status = "PENDING";

      feeBreakdown.push({
        id: a.id,
        source: "ASSIGNMENT",
        feeType: a.feeType,
        feeMonth: a.feeMonth ?? null,
        originalAmount: a.amount,
        // FIX (Gap 3): was always 0; now correctly reflects assignment concession
        concessionAmount,
        effectiveAmount,
        concessionReason: concession?.reason ?? null,
        dueDate: a.dueDate ?? null,
        isMandatory: a.isMandatory,
        description: a.description ?? null,
        amountPaid,
        balance,
        status,
      });
    }

    const totalOriginal = feeBreakdown.reduce(
      (s, f) => s + f.originalAmount,
      0
    );
    const totalConcession = feeBreakdown.reduce(
      (s, f) => s + f.concessionAmount,
      0
    );
    const totalDue = totalOriginal - totalConcession;
    const totalPaid = feeBreakdown.reduce((s, f) => s + f.amountPaid, 0);
    const balance = totalDue - totalPaid;
    const collectionRate =
      totalDue > 0 ? Math.round((totalPaid / totalDue) * 100) : 100;

    const allRecentPayments: StudentPaymentItem[] = [
      ...structurePayments.slice(0, 10).map((p: any) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        amountPaid: p.amountPaid,
        paymentMethod: p.paymentMethod,
        receiptNumber: p.receiptNumber,
        feeType: p.feeType,
        notes: p.notes ?? null,
      })),
      ...assignmentPayments.slice(0, 10).map((p: any) => {
        const a = assignments.find(
          (x: any) => x.id === p.studentFeeAssignmentId
        );
        return {
          id: p.id,
          paymentDate: p.paymentDate,
          amountPaid: p.amountPaid,
          paymentMethod: p.paymentMethod,
          receiptNumber: p.receiptNumber,
          feeType: a?.feeType ?? "CUSTOM",
          notes: p.notes ?? null,
        };
      }),
    ]
      .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
      .slice(0, 10);

    overviews.push({
      academicYearId: enrollment.academicYearId,
      academicYearName: enrollment.academicYearName,
      className: enrollment.className,
      sectionName: enrollment.sectionName,
      rollNumber: enrollment.rollNumber ?? null,
      totalOriginal,
      totalConcession,
      totalDue,
      totalPaid,
      balance,
      collectionRate,
      feeBreakdown,
      recentPayments: allRecentPayments,
    });
  }

  return overviews;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARENT: View Child's Fees
// ─────────────────────────────────────────────────────────────────────────────

export interface ParentChildFeeOverview extends StudentFeeOverview {
  studentName: string;
  studentEmail: string;
  studentId: number;
}

export async function getParentChildFees(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  parentUserId: number,
  childStudentId: number,
  academicYearId?: number
): Promise<ParentChildFeeOverview[]> {
  const db = await getSchoolDB(env, schoolCode);

  const relationship = await db
    .select({ studentId: studentParentsSchema.studentId })
    .from(studentParentsSchema)
    .where(
      and(
        eq(studentParentsSchema.parentId, parentUserId),
        eq(studentParentsSchema.studentId, childStudentId)
      )
    )
    .get();

  if (!relationship)
    throw new Error("Unauthorized: no parent-child relationship found");

  const studentInfo = await db
    .select({ name: schoolUsersSchema.name, email: schoolUsersSchema.email })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, childStudentId))
    .get();

  if (!studentInfo) throw new Error("Student not found");

  const overviews = await getStudentOwnFees(
    env,
    schoolCode,
    childStudentId,
    academicYearId
  );

  return overviews.map((o) => ({
    ...o,
    studentName: studentInfo.name,
    studentEmail: studentInfo.email,
    studentId: childStudentId,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// FEE STRUCTURES CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  if (typeof data.amount === "number" && data.amount <= 0) {
    throw new Error("Fee amount must be greater than zero");
  }

  const db = await getSchoolDB(env, schoolCode);

  // ── Duplicate month guard ──────────────────────────────────────────────────
  // Prevents a careless admin from calling POST /fees/structures twice for the
  // same (classSectionId, academicYearId, feeType, feeMonth) combination.
  // The bulk endpoint already has this check; single-create must too.
  // feeMonth = null means a one-time fee — duplicates are allowed for those
  // (e.g. two separate "ADMISSION" one-time charges are valid).
  if (data.feeMonth) {
    const duplicate = await db
      .select({ id: schoolFeeStructuresSchema.id })
      .from(schoolFeeStructuresSchema)
      .where(
        and(
          eq(schoolFeeStructuresSchema.classSectionId, data.classSectionId),
          eq(schoolFeeStructuresSchema.academicYearId, data.academicYearId),
          eq(schoolFeeStructuresSchema.feeType, data.feeType),
          eq(schoolFeeStructuresSchema.feeMonth, data.feeMonth)
        )
      )
      .get();

    if (duplicate) {
      throw new Error(
        `A fee structure for ${data.feeType} in ${data.feeMonth} already exists ` +
          `for this class-section. Delete or update the existing structure instead.`
      );
    }
  }

  const returning = await db
    .insert(schoolFeeStructuresSchema)
    .values(data)
    .returning();
  const newStructure = Array.isArray(returning) ? returning[0] : returning;
  if (!newStructure) throw new Error("Insert failed — no row returned");
  const fullStructure = await getFeeStructureById(db, newStructure.id);
  return { structure: fullStructure, message: "Fee structure created" };
}

export async function getFeeStructures(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);
  return await getFeeStructuresInternal(db);
}

async function getFeeStructuresInternal(db: any) {
  return db
    .select({
      id: schoolFeeStructuresSchema.id,
      academicYearId: schoolFeeStructuresSchema.academicYearId,
      classSectionId: schoolFeeStructuresSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      amount: schoolFeeStructuresSchema.amount,
      dueDate: schoolFeeStructuresSchema.dueDate,
      isMandatory: schoolFeeStructuresSchema.isMandatory,
      description: schoolFeeStructuresSchema.description,
      createdAt: schoolFeeStructuresSchema.createdAt,
      updatedAt: schoolFeeStructuresSchema.updatedAt,
    })
    .from(schoolFeeStructuresSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolFeeStructuresSchema.classSectionId, schoolClassSectionsSchema.id)
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
      schoolClassesSchema.name,
      schoolSectionsSchema.name,
      schoolFeeStructuresSchema.feeMonth,
      schoolFeeStructuresSchema.feeType
    )
    .all();
}

async function getFeeStructureById(db: any, id: number) {
  const row = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      academicYearId: schoolFeeStructuresSchema.academicYearId,
      classSectionId: schoolFeeStructuresSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      amount: schoolFeeStructuresSchema.amount,
      dueDate: schoolFeeStructuresSchema.dueDate,
      isMandatory: schoolFeeStructuresSchema.isMandatory,
      description: schoolFeeStructuresSchema.description,
      createdAt: schoolFeeStructuresSchema.createdAt,
      updatedAt: schoolFeeStructuresSchema.updatedAt,
    })
    .from(schoolFeeStructuresSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolFeeStructuresSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolFeeStructuresSchema.id, id))
    .get();

  if (!row) throw new Error(`Fee structure ${id} not found`);
  return row;
}

export async function updateFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);
  const returning = await db
    .update(schoolFeeStructuresSchema)
    .set({ ...data, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schoolFeeStructuresSchema.id, id))
    .returning();
  const updated = Array.isArray(returning) ? returning[0] : returning;
  if (!updated) throw new Error("Fee structure not found");
  return {
    structure: await getFeeStructureById(db, updated.id),
    message: "Fee structure updated",
  };
}

export async function deleteFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);
  const used = await db
    .select({ id: schoolFeePaymentsSchema.id })
    .from(schoolFeePaymentsSchema)
    .where(eq(schoolFeePaymentsSchema.feeStructureId, id))
    .limit(1)
    .get();
  if (used)
    throw new Error("Cannot delete fee structure with existing payments");
  const [deleted] = await db
    .delete(schoolFeeStructuresSchema)
    .where(eq(schoolFeeStructuresSchema.id, id))
    .returning();
  if (!deleted) throw new Error("Fee structure not found");
  return { message: "Fee structure deleted" };
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT LEDGER (concession-aware — now includes assignment concessions)
// ─────────────────────────────────────────────────────────────────────────────

export async function getStudentLedger(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  academicYearId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollments = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      academicYearName: schoolAcademicYearsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
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
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId))
    .all();

  const ledgers = [];

  for (const e of enrollments) {
    if (academicYearId && e.academicYearId !== academicYearId) continue;

    const fees = await db
      .select({
        id: schoolFeeStructuresSchema.id,
        feeType: schoolFeeStructuresSchema.feeType,
        feeMonth: schoolFeeStructuresSchema.feeMonth,
        amount: schoolFeeStructuresSchema.amount,
        dueDate: schoolFeeStructuresSchema.dueDate,
        isMandatory: schoolFeeStructuresSchema.isMandatory,
        description: schoolFeeStructuresSchema.description,
      })
      .from(schoolFeeStructuresSchema)
      .where(
        and(
          eq(schoolFeeStructuresSchema.classSectionId, e.classSectionId),
          eq(schoolFeeStructuresSchema.academicYearId, e.academicYearId)
        )
      )
      .all();

    const concessionMap = await getConcessionsForEnrollment(db, e.id);

    const assignments = await db
      .select()
      .from(schoolStudentFeeAssignmentsSchema)
      .where(
        and(
          eq(schoolStudentFeeAssignmentsSchema.enrollmentId, e.id),
          eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
        )
      )
      .all();

    // FIX (Gap 3): Fetch assignment-level concessions for ledger
    const assignmentConcessionMap = await getAssignmentConcessionsForEnrollment(
      db,
      e.id
    );

    const payments = await db
      .select({
        id: schoolFeePaymentsSchema.id,
        paymentDate: schoolFeePaymentsSchema.paymentDate,
        amountPaid: schoolFeePaymentsSchema.amountPaid,
        paymentMethod: schoolFeePaymentsSchema.paymentMethod,
        receiptNumber: schoolFeePaymentsSchema.receiptNumber,
        notes: schoolFeePaymentsSchema.notes,
        feeStructureId: schoolFeePaymentsSchema.feeStructureId,
        studentFeeAssignmentId: schoolFeePaymentsSchema.studentFeeAssignmentId,
      })
      .from(schoolFeePaymentsSchema)
      .where(
        and(
          eq(schoolFeePaymentsSchema.enrollmentId, e.id),
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      )
      .orderBy(desc(schoolFeePaymentsSchema.paymentDate))
      .all();

    let totalOriginal = 0;
    let totalConcession = 0;

    fees.forEach((f: any) => {
      totalOriginal += f.amount;
      const conc = concessionMap.get(f.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((f.amount * conc.concessionValue) / 100);
        totalConcession += Math.min(d, f.amount);
      }
    });

    // FIX (Gap 3): Include assignment concessions in ledger totals
    assignments.forEach((a: any) => {
      totalOriginal += a.amount;
      const conc = assignmentConcessionMap.get(a.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((a.amount * conc.concessionValue) / 100);
        totalConcession += Math.min(d, a.amount);
      }
    });

    const totalDue = totalOriginal - totalConcession;
    const totalPaid = payments.reduce(
      (s: number, p: any) => s + p.amountPaid,
      0
    );

    ledgers.push({
      yearId: e.academicYearId,
      academicYearName: e.academicYearName,
      studentName: e.studentName,
      className: e.className,
      sectionName: e.sectionName,
      rollNumber: e.rollNumber,
      totalOriginal,
      totalConcession,
      totalDue,
      totalPaid,
      balance: totalDue - totalPaid,
      details: {
        fees: fees.map((f: any) => {
          const conc = concessionMap.get(f.id);
          const concAmt = conc
            ? conc.concessionType === "FIXED"
              ? conc.concessionValue
              : Math.floor((f.amount * conc.concessionValue) / 100)
            : 0;
          return {
            ...f,
            concessionAmount: concAmt,
            effectiveAmount: f.amount - concAmt,
            concessionReason: conc?.reason ?? null,
          };
        }),
        // FIX (Gap 3): Include assignment concession details in ledger output
        assignments: assignments.map((a: any) => {
          const conc = assignmentConcessionMap.get(a.id);
          const concAmt = conc
            ? conc.concessionType === "FIXED"
              ? conc.concessionValue
              : Math.floor((a.amount * conc.concessionValue) / 100)
            : 0;
          return {
            ...a,
            concessionAmount: concAmt,
            effectiveAmount: a.amount - concAmt,
            concessionReason: conc?.reason ?? null,
          };
        }),
        payments,
      },
    });
  }

  return ledgers;
}

// ─────────────────────────────────────────────────────────────────────────────
// FEE REPORT (concession-aware)
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeReportRow {
  studentId: number;
  enrollmentId: number;
  studentName: string;
  rollNumber: string | null;
  className: string;
  sectionName: string;
  academicYearName: string;
  totalOriginal: number;
  totalConcession: number;
  totalDue: number;
  totalPaid: number;
  balance: number;
  customFeeTotal: number;
  customFeeConcession: number; // NEW — assignment-level concessions
  customFeeEffective: number; // NEW — customFeeTotal - customFeeConcession
  customFeePaid: number;
  customFeeBalance: number;
}

export interface FeeReportFilter {
  classSectionId: number;
  academicYearId?: number;
  overdueOnly?: boolean;
}

export async function getFeeReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: FeeReportFilter
): Promise<FeeReportRow[]> {
  const db = await getSchoolDB(env, schoolCode);

  let academicYearId = data.academicYearId;
  if (!academicYearId) {
    const current = await db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();
    if (!current) throw new Error("No current academic year configured.");
    academicYearId = current.id;
  }

  const enrollments = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      academicYearName: schoolAcademicYearsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
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
      schoolAcademicYearsSchema,
      eq(
        schoolStudentEnrollmentsSchema.academicYearId,
        schoolAcademicYearsSchema.id
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId),
        eq(schoolStudentEnrollmentsSchema.isActive, true),
        eq(schoolUsersSchema.isActive, true)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name)
    .all();

  if (enrollments.length === 0) return [];

  const feeStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, data.classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
      )
    )
    .all();

  const baseTotalPerStudent = feeStructures.reduce(
    (s: number, f: any) => s + f.amount,
    0
  );
  const feeStructureIds = feeStructures.map((f: any) => f.id);
  const enrollmentIds = enrollments.map((e: any) => e.enrollmentId);

  const structurePaymentRows =
    feeStructureIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeePaymentsSchema.enrollmentId,
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds),
              inArray(schoolFeePaymentsSchema.feeStructureId, feeStructureIds),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .groupBy(schoolFeePaymentsSchema.enrollmentId)
          .all()
      : [];

  const structurePaidMap = new Map<number, number>(
    structurePaymentRows.map((r: any) => [r.enrollmentId, r.totalPaid])
  );

  const allConcessions =
    feeStructureIds.length > 0 && enrollmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
            feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds),
              eq(schoolFeeConcessionsSchema.isActive, true),
              sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`
            )
          )
          .all()
      : [];

  const concessionsByEnrollment = new Map<number, Map<number, any>>();
  allConcessions.forEach((c: any) => {
    if (!concessionsByEnrollment.has(c.enrollmentId)) {
      concessionsByEnrollment.set(c.enrollmentId, new Map());
    }
    concessionsByEnrollment.get(c.enrollmentId)!.set(c.feeStructureId, c);
  });

  // ── Custom assignments (with their own concessions) ───────────────────────
  const customAssignments =
    enrollmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolStudentFeeAssignmentsSchema.enrollmentId,
            amount: schoolStudentFeeAssignmentsSchema.amount,
            id: schoolStudentFeeAssignmentsSchema.id,
          })
          .from(schoolStudentFeeAssignmentsSchema)
          .where(
            and(
              inArray(
                schoolStudentFeeAssignmentsSchema.enrollmentId,
                enrollmentIds
              ),
              eq(
                schoolStudentFeeAssignmentsSchema.academicYearId,
                academicYearId
              ),
              eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
            )
          )
          .all()
      : [];

  const customTotalMap = new Map<number, number>();
  const customAssignmentIds: number[] = [];
  customAssignments.forEach((a: any) => {
    customTotalMap.set(
      a.enrollmentId,
      (customTotalMap.get(a.enrollmentId) ?? 0) + a.amount
    );
    customAssignmentIds.push(a.id);
  });

  // FIX (Gap 3): Fetch assignment-level concessions for the report
  const allAssignmentConcessions =
    customAssignmentIds.length > 0 && enrollmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
            assignmentId: schoolFeeConcessionsSchema.studentFeeAssignmentId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds),
              inArray(
                schoolFeeConcessionsSchema.studentFeeAssignmentId,
                customAssignmentIds
              ),
              eq(schoolFeeConcessionsSchema.isActive, true)
            )
          )
          .all()
      : [];

  // Map: enrollmentId → Map<assignmentId, concession>
  const assignmentConcessionsByEnrollment = new Map<number, Map<number, any>>();
  allAssignmentConcessions.forEach((c: any) => {
    if (!assignmentConcessionsByEnrollment.has(c.enrollmentId))
      assignmentConcessionsByEnrollment.set(c.enrollmentId, new Map());
    assignmentConcessionsByEnrollment
      .get(c.enrollmentId)!
      .set(c.assignmentId, c);
  });

  const customPaymentRows =
    customAssignmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeePaymentsSchema.enrollmentId,
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              inArray(
                schoolFeePaymentsSchema.studentFeeAssignmentId,
                customAssignmentIds
              ),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .groupBy(schoolFeePaymentsSchema.enrollmentId)
          .all()
      : [];

  const customPaidMap = new Map<number, number>(
    customPaymentRows.map((r: any) => [r.enrollmentId, r.totalPaid])
  );

  const report: FeeReportRow[] = [];

  for (const e of enrollments) {
    const enrollmentConcessions =
      concessionsByEnrollment.get(e.enrollmentId) ?? new Map();

    let totalConcession = 0;
    feeStructures.forEach((fee: any) => {
      const conc = enrollmentConcessions.get(fee.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((fee.amount * conc.concessionValue) / 100);
        totalConcession += Math.min(d, fee.amount);
      }
    });

    const totalOriginal = baseTotalPerStudent;
    const totalDue = totalOriginal - totalConcession;
    const totalPaid = structurePaidMap.get(e.enrollmentId) ?? 0;
    const balance = totalDue - totalPaid;

    // FIX (Gap 3): Compute assignment concession per enrollment
    const enrollmentAssignments = customAssignments.filter(
      (a: any) => a.enrollmentId === e.enrollmentId
    );
    const enrollmentAssignmentConcessions =
      assignmentConcessionsByEnrollment.get(e.enrollmentId) ?? new Map();

    let customFeeConcession = 0;
    enrollmentAssignments.forEach((a: any) => {
      const conc = enrollmentAssignmentConcessions.get(a.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((a.amount * conc.concessionValue) / 100);
        customFeeConcession += Math.min(d, a.amount);
      }
    });

    const customFeeTotal = customTotalMap.get(e.enrollmentId) ?? 0;
    const customFeeEffective = Math.max(
      0,
      customFeeTotal - customFeeConcession
    );
    const customFeePaid = customPaidMap.get(e.enrollmentId) ?? 0;
    const customFeeBalance = customFeeEffective - customFeePaid;

    if (data.overdueOnly && balance <= 0 && customFeeBalance <= 0) continue;

    report.push({
      studentId: e.studentId,
      enrollmentId: e.enrollmentId,
      studentName: e.studentName,
      rollNumber: e.rollNumber ?? null,
      className: e.className,
      sectionName: e.sectionName,
      academicYearName: e.academicYearName,
      totalOriginal,
      totalConcession,
      totalDue,
      totalPaid,
      balance,
      customFeeTotal,
      customFeeConcession,
      customFeeEffective,
      customFeePaid,
      customFeeBalance,
    });
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENTS BY CLASS-SECTION
// ─────────────────────────────────────────────────────────────────────────────

export async function getStudentsByClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const currentYear = await db
    .select({ id: schoolAcademicYearsSchema.id })
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();
  if (!currentYear) throw new Error("No current academic year found");

  const enrollments = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true),
        eq(schoolUsersSchema.isActive, true)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name)
    .all();

  if (enrollments.length === 0) return [];

  const enrollmentIds = enrollments.map((e: any) => e.enrollmentId);

  // ── 1. Standard fee structures for this class-section ────────────────────
  const feeStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, currentYear.id)
      )
    )
    .all();

  const baseTotalPerStudent = feeStructures.reduce(
    (s: number, f: any) => s + f.amount,
    0
  );
  const feeStructureIds = feeStructures.map((f: any) => f.id);

  // ── 2. Standard fee payments per enrollment ───────────────────────────────
  const structurePaymentRows =
    feeStructureIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeePaymentsSchema.enrollmentId,
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              inArray(schoolFeePaymentsSchema.enrollmentId, enrollmentIds),
              inArray(schoolFeePaymentsSchema.feeStructureId, feeStructureIds),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .groupBy(schoolFeePaymentsSchema.enrollmentId)
          .all()
      : [];

  const structurePaidMap = new Map<number, number>(
    structurePaymentRows.map((r: any) => [r.enrollmentId, r.totalPaid])
  );

  // ── 3. Standard fee concessions per enrollment ────────────────────────────
  const allStructureConcessions =
    feeStructureIds.length > 0 && enrollmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
            feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds),
              eq(schoolFeeConcessionsSchema.isActive, true),
              sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`
            )
          )
          .all()
      : [];

  const structureConcessionsByEnrollment = new Map<number, Map<number, any>>();
  allStructureConcessions.forEach((c: any) => {
    if (!structureConcessionsByEnrollment.has(c.enrollmentId))
      structureConcessionsByEnrollment.set(c.enrollmentId, new Map());
    structureConcessionsByEnrollment
      .get(c.enrollmentId)!
      .set(c.feeStructureId, c);
  });

  // ── 4. Custom fee assignments per enrollment ──────────────────────────────
  const customAssignments =
    enrollmentIds.length > 0
      ? await db
          .select({
            id: schoolStudentFeeAssignmentsSchema.id,
            enrollmentId: schoolStudentFeeAssignmentsSchema.enrollmentId,
            amount: schoolStudentFeeAssignmentsSchema.amount,
          })
          .from(schoolStudentFeeAssignmentsSchema)
          .where(
            and(
              inArray(
                schoolStudentFeeAssignmentsSchema.enrollmentId,
                enrollmentIds
              ),
              eq(
                schoolStudentFeeAssignmentsSchema.academicYearId,
                currentYear.id
              ),
              eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
            )
          )
          .all()
      : [];

  // Map: enrollmentId → total original custom amount
  const customOriginalMap = new Map<number, number>();
  const customAssignmentIds: number[] = [];
  customAssignments.forEach((a: any) => {
    customOriginalMap.set(
      a.enrollmentId,
      (customOriginalMap.get(a.enrollmentId) ?? 0) + a.amount
    );
    customAssignmentIds.push(a.id);
  });

  // ── 5. Assignment-level concessions ──────────────────────────────────────
  const allAssignmentConcessions =
    customAssignmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
            studentFeeAssignmentId:
              schoolFeeConcessionsSchema.studentFeeAssignmentId,
            concessionType: schoolFeeConcessionsSchema.concessionType,
            concessionValue: schoolFeeConcessionsSchema.concessionValue,
          })
          .from(schoolFeeConcessionsSchema)
          .where(
            and(
              inArray(schoolFeeConcessionsSchema.enrollmentId, enrollmentIds),
              inArray(
                schoolFeeConcessionsSchema.studentFeeAssignmentId,
                customAssignmentIds
              ),
              eq(schoolFeeConcessionsSchema.isActive, true)
            )
          )
          .all()
      : [];

  // Map: enrollmentId → Map<assignmentId, concession>
  const assignmentConcessionsByEnrollment = new Map<number, Map<number, any>>();
  allAssignmentConcessions.forEach((c: any) => {
    if (!assignmentConcessionsByEnrollment.has(c.enrollmentId))
      assignmentConcessionsByEnrollment.set(c.enrollmentId, new Map());
    assignmentConcessionsByEnrollment
      .get(c.enrollmentId)!
      .set(c.studentFeeAssignmentId, c);
  });

  // ── 6. Custom fee payments per enrollment ─────────────────────────────────
  const customPaymentRows =
    customAssignmentIds.length > 0
      ? await db
          .select({
            enrollmentId: schoolFeePaymentsSchema.enrollmentId,
            totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              inArray(
                schoolFeePaymentsSchema.studentFeeAssignmentId,
                customAssignmentIds
              ),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .groupBy(schoolFeePaymentsSchema.enrollmentId)
          .all()
      : [];

  const customPaidMap = new Map<number, number>(
    customPaymentRows.map((r: any) => [r.enrollmentId, r.totalPaid])
  );

  // ── 7. Assemble per-student row ───────────────────────────────────────────
  return enrollments.map((e: any) => {
    // Standard fee concessions for this enrollment
    const enrollmentStructureConcessions =
      structureConcessionsByEnrollment.get(e.enrollmentId) ?? new Map();
    let stdConcession = 0;
    feeStructures.forEach((fee: any) => {
      const conc = enrollmentStructureConcessions.get(fee.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((fee.amount * conc.concessionValue) / 100);
        stdConcession += Math.min(d, fee.amount);
      }
    });

    // Custom fee concessions for this enrollment
    const enrollmentAssignmentConcessions =
      assignmentConcessionsByEnrollment.get(e.enrollmentId) ?? new Map();
    const enrollmentAssignments = customAssignments.filter(
      (a: any) => a.enrollmentId === e.enrollmentId
    );
    let customConcession = 0;
    enrollmentAssignments.forEach((a: any) => {
      const conc = enrollmentAssignmentConcessions.get(a.id);
      if (conc) {
        const d =
          conc.concessionType === "FIXED"
            ? conc.concessionValue
            : Math.floor((a.amount * conc.concessionValue) / 100);
        customConcession += Math.min(d, a.amount);
      }
    });

    const totalConcession = stdConcession + customConcession;

    const stdOriginal = baseTotalPerStudent;
    const customOriginal = customOriginalMap.get(e.enrollmentId) ?? 0;
    const totalOriginal = stdOriginal + customOriginal;

    const stdEffective = stdOriginal - stdConcession;
    const customEffective = customOriginal - customConcession;
    const totalAssigned = stdEffective + customEffective; // net due after all concessions

    const stdPaid = structurePaidMap.get(e.enrollmentId) ?? 0;
    const customPaid = customPaidMap.get(e.enrollmentId) ?? 0;
    const totalPaid = stdPaid + customPaid;

    return {
      id: e.studentId,
      name: e.name,
      email: e.email,
      rollNumber: e.rollNumber ?? null,
      enrollmentId: e.enrollmentId,
      totalOriginal, // standard + custom original amounts
      totalConcession, // standard + custom concessions
      totalAssigned, // net due (after all concessions)
      totalPaid, // standard + custom paid
      balance: totalAssigned - totalPaid,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DUE FEES FOR ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

export async function getDueFeesForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
    })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.id, enrollmentId))
    .get();

  if (!enrollment) throw new Error("Enrollment not found");

  const fees = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      amount: schoolFeeStructuresSchema.amount,
      dueDate: schoolFeeStructuresSchema.dueDate,
      isMandatory: schoolFeeStructuresSchema.isMandatory,
      description: schoolFeeStructuresSchema.description,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, enrollment.classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, enrollment.academicYearId)
      )
    )
    .orderBy(
      schoolFeeStructuresSchema.feeMonth,
      schoolFeeStructuresSchema.feeType
    )
    .all();

  const concessionMap = await getConcessionsForEnrollment(db, enrollmentId);

  const structurePayments = await db
    .select({
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId),
        eq(schoolFeePaymentsSchema.isVoid, false),
        sql`${schoolFeePaymentsSchema.feeStructureId} IS NOT NULL`
      )
    )
    .all();

  const structurePaidMap = new Map<number, number>();
  structurePayments.forEach((p: any) => {
    if (p.feeStructureId) {
      structurePaidMap.set(
        p.feeStructureId,
        (structurePaidMap.get(p.feeStructureId) ?? 0) + p.amountPaid
      );
    }
  });

  const assignments = await db
    .select({
      id: schoolStudentFeeAssignmentsSchema.id,
      feeType: schoolStudentFeeAssignmentsSchema.feeType,
      feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
      amount: schoolStudentFeeAssignmentsSchema.amount,
      dueDate: schoolStudentFeeAssignmentsSchema.dueDate,
      isMandatory: schoolStudentFeeAssignmentsSchema.isMandatory,
      description: schoolStudentFeeAssignmentsSchema.description,
    })
    .from(schoolStudentFeeAssignmentsSchema)
    .where(
      and(
        eq(schoolStudentFeeAssignmentsSchema.enrollmentId, enrollmentId),
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
      )
    )
    .orderBy(
      schoolStudentFeeAssignmentsSchema.feeMonth,
      schoolStudentFeeAssignmentsSchema.feeType
    )
    .all();

  // FIX (Gap 3): Fetch assignment concessions for due fees view
  const assignmentConcessionMap = await getAssignmentConcessionsForEnrollment(
    db,
    enrollmentId
  );

  const assignmentPayments =
    assignments.length > 0
      ? await db
          .select({
            studentFeeAssignmentId:
              schoolFeePaymentsSchema.studentFeeAssignmentId,
            amountPaid: schoolFeePaymentsSchema.amountPaid,
          })
          .from(schoolFeePaymentsSchema)
          .where(
            and(
              inArray(
                schoolFeePaymentsSchema.studentFeeAssignmentId,
                assignments.map((a: any) => a.id)
              ),
              eq(schoolFeePaymentsSchema.isVoid, false)
            )
          )
          .all()
      : [];

  const assignmentPaidMap = new Map<number, number>();
  assignmentPayments.forEach((p: any) => {
    if (p.studentFeeAssignmentId) {
      assignmentPaidMap.set(
        p.studentFeeAssignmentId,
        (assignmentPaidMap.get(p.studentFeeAssignmentId) ?? 0) + p.amountPaid
      );
    }
  });

  const enrichedFees = fees.map((fee: any) => {
    const concession = concessionMap.get(fee.id) ?? null;
    const concessionAmount = concession
      ? concession.concessionType === "FIXED"
        ? concession.concessionValue
        : Math.floor((fee.amount * concession.concessionValue) / 100)
      : 0;
    const effectiveAmount = Math.max(0, fee.amount - concessionAmount);
    const paid = structurePaidMap.get(fee.id) ?? 0;
    return {
      ...fee,
      source: "STRUCTURE" as const,
      concessionAmount,
      effectiveAmount,
      concessionReason: concession?.reason ?? null,
      paid,
      remaining: Math.max(0, effectiveAmount - paid),
    };
  });

  // FIX (Gap 3): Apply assignment concessions in due fees response
  const enrichedAssignments = assignments.map((a: any) => {
    const concession = assignmentConcessionMap.get(a.id) ?? null;
    const concessionAmount = concession
      ? concession.concessionType === "FIXED"
        ? concession.concessionValue
        : Math.floor((a.amount * concession.concessionValue) / 100)
      : 0;
    const effectiveAmount = Math.max(0, a.amount - concessionAmount);
    const paid = assignmentPaidMap.get(a.id) ?? 0;
    return {
      ...a,
      source: "ASSIGNMENT" as const,
      concessionAmount,
      effectiveAmount,
      concessionReason: concession?.reason ?? null,
      paid,
      remaining: Math.max(0, effectiveAmount - paid),
    };
  });

  const allFees = [...enrichedFees, ...enrichedAssignments];
  const totalDue = allFees.reduce((s, f) => s + f.effectiveAmount, 0);
  const totalPaid = allFees.reduce((s, f) => s + f.paid, 0);
  const balanceDue = Math.max(0, totalDue - totalPaid);
  const totalConcession = allFees.reduce((s, f) => s + f.concessionAmount, 0);

  return {
    fees: enrichedFees,
    assignments: enrichedAssignments,
    totalDue,
    totalPaid,
    balanceDue,
    totalConcession,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT HISTORY
// ─────────────────────────────────────────────────────────────────────────────

export async function getPaymentsForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const structurePayments = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      paymentDate: schoolFeePaymentsSchema.paymentDate,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      paymentMethod: schoolFeePaymentsSchema.paymentMethod,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      notes: schoolFeePaymentsSchema.notes,
      isVoid: schoolFeePaymentsSchema.isVoid,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      dueDate: schoolFeeStructuresSchema.dueDate,
      source: sql<string>`'STRUCTURE'`,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolFeeStructuresSchema,
      eq(schoolFeePaymentsSchema.feeStructureId, schoolFeeStructuresSchema.id)
    )
    .where(
      and(
        eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId),
        eq(schoolFeePaymentsSchema.isVoid, false),
        sql`${schoolFeePaymentsSchema.feeStructureId} IS NOT NULL`
      )
    )
    .all();

  const assignmentPayments = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      paymentDate: schoolFeePaymentsSchema.paymentDate,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      paymentMethod: schoolFeePaymentsSchema.paymentMethod,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      notes: schoolFeePaymentsSchema.notes,
      isVoid: schoolFeePaymentsSchema.isVoid,
      feeType: schoolStudentFeeAssignmentsSchema.feeType,
      feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
      dueDate: schoolStudentFeeAssignmentsSchema.dueDate,
      source: sql<string>`'ASSIGNMENT'`,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolStudentFeeAssignmentsSchema,
      eq(
        schoolFeePaymentsSchema.studentFeeAssignmentId,
        schoolStudentFeeAssignmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId),
        eq(schoolFeePaymentsSchema.isVoid, false),
        sql`${schoolFeePaymentsSchema.studentFeeAssignmentId} IS NOT NULL`
      )
    )
    .all();

  return [...structurePayments, ...assignmentPayments].sort((a, b) =>
    b.paymentDate.localeCompare(a.paymentDate)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FEES DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeesDashboard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  if (!academicYearId) {
    const current = await db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();
    if (current) academicYearId = current.id;
  }

  const assignedResult = await db
    .select({
      totalAssigned: sql<number>`COALESCE(SUM(${schoolFeeStructuresSchema.amount}), 0)`,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        academicYearId
          ? eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolFeeStructuresSchema.classSectionId, classSectionId)
          : undefined
      )
    )
    .get();

  // ── Structure-level concession total (floored to avoid fractional paise) ──
  // CAST(FLOOR(...)) mirrors the JS-side applyDiscount() Math.floor so that
  // dashboard totals match per-student ledger calculations exactly.
  const concessionResult = await db
    .select({
      totalConcession: sql<number>`COALESCE(SUM(
        CASE
          WHEN ${schoolFeeConcessionsSchema.concessionType} = 'FIXED'
          THEN MIN(${schoolFeeConcessionsSchema.concessionValue}, ${schoolFeeStructuresSchema.amount})
          ELSE CAST(FLOOR(
            CAST(${schoolFeeStructuresSchema.amount} AS REAL)
            * ${schoolFeeConcessionsSchema.concessionValue} / 100.0
          ) AS INTEGER)
        END
      ), 0)`,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolFeeStructuresSchema,
      eq(
        schoolFeeConcessionsSchema.feeStructureId,
        schoolFeeStructuresSchema.id
      )
    )
    .where(
      and(
        eq(schoolFeeConcessionsSchema.isActive, true),
        sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`,
        academicYearId
          ? eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolFeeStructuresSchema.classSectionId, classSectionId)
          : undefined
      )
    )
    .get();

  const collectedResult = await db
    .select({
      totalCollected: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolFeePaymentsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        academicYearId
          ? eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId)
          : undefined,
        eq(schoolFeePaymentsSchema.isVoid, false),
        sql`${schoolFeePaymentsSchema.feeStructureId} IS NOT NULL`
      )
    )
    .get();

  const customAssignedResult = await db
    .select({
      totalCustom: sql<number>`COALESCE(SUM(${schoolStudentFeeAssignmentsSchema.amount}), 0)`,
    })
    .from(schoolStudentFeeAssignmentsSchema)
    .where(
      and(
        academicYearId
          ? eq(schoolStudentFeeAssignmentsSchema.academicYearId, academicYearId)
          : undefined,
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
      )
    )
    .get();

  // ── Assignment-level concession total (floored to avoid fractional paise) ──
  const customConcessionResult = await db
    .select({
      totalCustomConcession: sql<number>`COALESCE(SUM(
       CASE
         WHEN ${schoolFeeConcessionsSchema.concessionType} = 'FIXED'
         THEN MIN(${schoolFeeConcessionsSchema.concessionValue}, ${schoolStudentFeeAssignmentsSchema.amount})
         ELSE CAST(FLOOR(
           CAST(${schoolStudentFeeAssignmentsSchema.amount} AS REAL)
           * ${schoolFeeConcessionsSchema.concessionValue} / 100.0
         ) AS INTEGER)
       END
     ), 0)`,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolStudentFeeAssignmentsSchema,
      eq(
        schoolFeeConcessionsSchema.studentFeeAssignmentId,
        schoolStudentFeeAssignmentsSchema.id
      )
    )
    .where(
      and(
        eq(schoolFeeConcessionsSchema.isActive, true),
        sql`${schoolFeeConcessionsSchema.studentFeeAssignmentId} IS NOT NULL`,
        academicYearId
          ? eq(schoolStudentFeeAssignmentsSchema.academicYearId, academicYearId)
          : undefined,
        eq(schoolStudentFeeAssignmentsSchema.isCancelled, false)
      )
    )
    .get();

  const customCollectedResult = await db
    .select({
      totalCustomPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolStudentFeeAssignmentsSchema,
      eq(
        schoolFeePaymentsSchema.studentFeeAssignmentId,
        schoolStudentFeeAssignmentsSchema.id
      )
    )
    .where(
      and(
        academicYearId
          ? eq(schoolStudentFeeAssignmentsSchema.academicYearId, academicYearId)
          : undefined,
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .get();

  const todayResult = await db
    .select({
      today: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        sql`date(${schoolFeePaymentsSchema.paymentDate}) = date('now')`,
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .get();

  // ── FIX (Bug 1): Overdue calculation — per-enrollment, class-section scoped ─
  //
  // Previous bugs:
  //   A. allEnrollmentsForOverdue fetched ALL active enrollments school-wide
  //      when classSectionId was given — now scoped by classSectionId.
  //   B. The inner loop over overdueStructures ran for every enrollment in
  //      overduePaidMap regardless of whether that enrollment belongs to the
  //      same classSectionId as the overdue structure — now guarded by joining
  //      enrollments to their classSectionId before iterating.
  let totalOverdue = 0;

  const overdueStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
      classSectionId: schoolFeeStructuresSchema.classSectionId, // kept for cross-check
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        academicYearId
          ? eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolFeeStructuresSchema.classSectionId, classSectionId)
          : undefined,
        sql`${schoolFeeStructuresSchema.dueDate} IS NOT NULL`,
        sql`date(${schoolFeeStructuresSchema.dueDate}) < date('now')`
      )
    )
    .all();

  if (overdueStructures.length > 0) {
    const overdueIds = overdueStructures.map((s: any) => s.id);

    const overduePayments = await db
      .select({
        feeStructureId: schoolFeePaymentsSchema.feeStructureId,
        enrollmentId: schoolFeePaymentsSchema.enrollmentId,
        totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
      })
      .from(schoolFeePaymentsSchema)
      .where(
        and(
          inArray(schoolFeePaymentsSchema.feeStructureId, overdueIds),
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      )
      .groupBy(
        schoolFeePaymentsSchema.feeStructureId,
        schoolFeePaymentsSchema.enrollmentId
      )
      .all();

    const overdueConcessions = await db
      .select({
        enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
        feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
        concessionType: schoolFeeConcessionsSchema.concessionType,
        concessionValue: schoolFeeConcessionsSchema.concessionValue,
      })
      .from(schoolFeeConcessionsSchema)
      .where(
        and(
          inArray(schoolFeeConcessionsSchema.feeStructureId, overdueIds),
          eq(schoolFeeConcessionsSchema.isActive, true)
        )
      )
      .all();

    const overdueConcessionMap = new Map<number, Map<number, any>>();
    overdueConcessions.forEach((c: any) => {
      if (!overdueConcessionMap.has(c.enrollmentId))
        overdueConcessionMap.set(c.enrollmentId, new Map());
      overdueConcessionMap.get(c.enrollmentId)!.set(c.feeStructureId, c);
    });

    const overduePaidMap = new Map<number, Map<number, number>>();
    overduePayments.forEach((r: any) => {
      if (!overduePaidMap.has(r.enrollmentId))
        overduePaidMap.set(r.enrollmentId, new Map());
      overduePaidMap.get(r.enrollmentId)!.set(r.feeStructureId, r.totalPaid);
    });

    // ── FIX (Bug 1A): Fetch enrollments scoped to the same classSectionId(s)
    // as the overdue fee structures — NOT all active enrollments school-wide.
    //
    // When classSectionId is provided: filter to just that section.
    // When no classSectionId (school-wide dashboard): filter to only the
    // class-sections that actually have overdue structures, preventing
    // cross-section contamination.
    const overdueSectionIds = [
      ...new Set(overdueStructures.map((s: any) => s.classSectionId)),
    ];

    const allEnrollmentsForOverdue = await db
      .select({
        enrollmentId: schoolStudentEnrollmentsSchema.id,
        classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.isActive, true),
          academicYearId
            ? eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId)
            : undefined,
          // FIX (Bug 1A): scope to only the sections that have overdue structures
          inArray(
            schoolStudentEnrollmentsSchema.classSectionId,
            overdueSectionIds
          )
        )
      )
      .all();

    for (const [enrollmentId, paidByFee] of overduePaidMap) {
      const concessionByFee =
        overdueConcessionMap.get(enrollmentId) ?? new Map();

      // FIX (Bug 1B): only iterate over structures that belong to the
      // same classSectionId as this enrollment — prevents cross-section
      // contamination when no classSectionId filter is active.
      const enrollmentRecord = allEnrollmentsForOverdue.find(
        (e: any) => e.enrollmentId === enrollmentId
      );
      if (!enrollmentRecord) continue;

      for (const fee of overdueStructures) {
        // Guard: skip if this fee structure is for a different section
        if (fee.classSectionId !== enrollmentRecord.classSectionId) continue;

        const conc = concessionByFee.get(fee.id) ?? null;
        const effectiveAmount = applyDiscount(fee.amount, conc);
        const paid = paidByFee.get(fee.id) ?? 0;
        const remaining = effectiveAmount - paid;
        if (remaining > 0) totalOverdue += remaining;
      }
    }

    // Also include enrollments with NO payments (full balance overdue)
    const enrollmentsWithPayments = new Set(overduePaidMap.keys());

    for (const enrollment of allEnrollmentsForOverdue) {
      if (enrollmentsWithPayments.has(enrollment.enrollmentId)) continue;

      const concessionByFee =
        overdueConcessionMap.get(enrollment.enrollmentId) ?? new Map();

      for (const fee of overdueStructures) {
        // FIX (Bug 1B): skip structures from other sections
        if (fee.classSectionId !== enrollment.classSectionId) continue;

        const conc = concessionByFee.get(fee.id) ?? null;
        const effectiveAmount = applyDiscount(fee.amount, conc);
        if (effectiveAmount > 0) totalOverdue += effectiveAmount;
      }
    }
  }

  const totalAssigned = assignedResult?.totalAssigned ?? 0;
  const totalConcession = Math.floor(concessionResult?.totalConcession ?? 0);
  const totalEffectiveAssigned = totalAssigned - totalConcession;
  const totalCollected = collectedResult?.totalCollected ?? 0;
  const totalOutstanding = Math.max(0, totalEffectiveAssigned - totalCollected);
  const collectionRate =
    totalEffectiveAssigned > 0
      ? Math.round((totalCollected / totalEffectiveAssigned) * 100)
      : 0;

  const totalCustomAssigned = customAssignedResult?.totalCustom ?? 0;
  const totalCustomConcession = Math.floor(
    customConcessionResult?.totalCustomConcession ?? 0
  );
  const totalCustomEffective = Math.max(
    0,
    totalCustomAssigned - totalCustomConcession
  );
  const totalCustomCollected = customCollectedResult?.totalCustomPaid ?? 0;
  const totalCustomOutstanding = Math.max(
    0,
    totalCustomEffective - totalCustomCollected
  );

  return {
    totalAssigned,
    totalConcession,
    totalEffectiveAssigned,
    totalCollected,
    totalOutstanding,
    totalOverdue,
    collectionRate,
    totalCustomAssigned,
    totalCustomConcession,
    totalCustomEffective,
    totalCustomCollected,
    totalCustomOutstanding,
    grandTotalAssigned: totalEffectiveAssigned + totalCustomEffective,
    grandTotalCollected: totalCollected + totalCustomCollected,
    grandTotalOutstanding: totalOutstanding + totalCustomOutstanding,
    todayCollected: todayResult?.today ?? 0,
    academicYearId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCESSION DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

export interface ConcessionSummaryRow {
  concessionId: number;
  enrollmentId: number;
  studentName: string;
  studentId: number;
  className: string;
  sectionName: string;
  source: "STRUCTURE" | "ASSIGNMENT";
  feeType: string;
  feeMonth: string | null;
  originalAmount: number;
  concessionType: "PERCENTAGE" | "FIXED";
  concessionValue: number;
  concessionAmount: number;
  effectiveAmount: number;
  reason: string;
  approvedByName: string;
  isActive: boolean;
  createdAt: string;
}

export async function getConcessionDashboard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
): Promise<{ rows: ConcessionSummaryRow[]; totalConcessionAmount: number }> {
  const db = await getSchoolDB(env, schoolCode);

  if (!academicYearId) {
    const current = await db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();
    if (current) academicYearId = current.id;
  }

  // ── Structure-level concessions ───────────────────────────────────────────
  const structureRows = await db
    .select({
      concessionId: schoolFeeConcessionsSchema.id,
      enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
      studentName: schoolUsersSchema.name,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      feeType: schoolFeeStructuresSchema.feeType,
      feeMonth: schoolFeeStructuresSchema.feeMonth,
      originalAmount: schoolFeeStructuresSchema.amount,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
      isActive: schoolFeeConcessionsSchema.isActive,
      createdAt: schoolFeeConcessionsSchema.createdAt,
      approvedBy: schoolFeeConcessionsSchema.approvedBy,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolFeeStructuresSchema,
      eq(
        schoolFeeConcessionsSchema.feeStructureId,
        schoolFeeStructuresSchema.id
      )
    )
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolFeeConcessionsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
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
      and(
        sql`${schoolFeeConcessionsSchema.feeStructureId} IS NOT NULL`,
        academicYearId
          ? eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolFeeStructuresSchema.classSectionId, classSectionId)
          : undefined
      )
    )
    .orderBy(desc(schoolFeeConcessionsSchema.createdAt))
    .all();

  // ── Assignment-level concessions ──────────────────────────────────────────
  const assignmentRows = await db
    .select({
      concessionId: schoolFeeConcessionsSchema.id,
      enrollmentId: schoolFeeConcessionsSchema.enrollmentId,
      studentName: schoolUsersSchema.name,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      feeType: schoolStudentFeeAssignmentsSchema.feeType,
      feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
      originalAmount: schoolStudentFeeAssignmentsSchema.amount,
      concessionType: schoolFeeConcessionsSchema.concessionType,
      concessionValue: schoolFeeConcessionsSchema.concessionValue,
      reason: schoolFeeConcessionsSchema.reason,
      isActive: schoolFeeConcessionsSchema.isActive,
      createdAt: schoolFeeConcessionsSchema.createdAt,
      approvedBy: schoolFeeConcessionsSchema.approvedBy,
    })
    .from(schoolFeeConcessionsSchema)
    .innerJoin(
      schoolStudentFeeAssignmentsSchema,
      eq(
        schoolFeeConcessionsSchema.studentFeeAssignmentId,
        schoolStudentFeeAssignmentsSchema.id
      )
    )
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolFeeConcessionsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
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
      and(
        sql`${schoolFeeConcessionsSchema.studentFeeAssignmentId} IS NOT NULL`,
        academicYearId
          ? eq(schoolStudentFeeAssignmentsSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId)
          : undefined
      )
    )
    .orderBy(desc(schoolFeeConcessionsSchema.createdAt))
    .all();

  // Batch-fetch approver names
  const allRows = [...structureRows, ...assignmentRows];
  const approverIds = [
    ...new Set(allRows.map((r: any) => r.approvedBy).filter(Boolean)),
  ];
  let approverNameMap = new Map<number, string>();
  if (approverIds.length > 0) {
    const approvers = await db
      .select({ id: schoolUsersSchema.id, name: schoolUsersSchema.name })
      .from(schoolUsersSchema)
      .where(inArray(schoolUsersSchema.id, approverIds))
      .all();
    approverNameMap = new Map(approvers.map((a: any) => [a.id, a.name]));
  }

  const enriched: ConcessionSummaryRow[] = allRows
    .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))
    .map((r: any) => {
      const isStructure = structureRows.includes(r);
      const concessionAmount =
        r.concessionType === "FIXED"
          ? r.concessionValue
          : Math.floor((r.originalAmount * r.concessionValue) / 100);
      return {
        concessionId: r.concessionId,
        enrollmentId: r.enrollmentId,
        studentName: r.studentName,
        studentId: r.studentId,
        className: r.className,
        sectionName: r.sectionName,
        source: (isStructure ? "STRUCTURE" : "ASSIGNMENT") as
          | "STRUCTURE"
          | "ASSIGNMENT",
        feeType: r.feeType,
        feeMonth: r.feeMonth ?? null,
        originalAmount: r.originalAmount,
        concessionType: r.concessionType,
        concessionValue: r.concessionValue,
        reason: r.reason,
        isActive: r.isActive,
        createdAt: r.createdAt,
        approvedByName: approverNameMap.get(r.approvedBy) ?? "Unknown",
        concessionAmount: Math.min(concessionAmount, r.originalAmount),
        effectiveAmount: Math.max(0, r.originalAmount - concessionAmount),
      };
    });

  const totalConcessionAmount = enriched
    .filter((r) => r.isActive)
    .reduce((s, r) => s + r.concessionAmount, 0);

  return { rows: enriched, totalConcessionAmount };
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION TREND & BREAKDOWN
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeesCollectionTrend(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);
  return db
    .select({
      date: sql<string>`date(${schoolFeePaymentsSchema.paymentDate})`,
      amount: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolFeePaymentsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .where(
      and(
        academicYearId
          ? eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId)
          : undefined,
        sql`${schoolFeePaymentsSchema.paymentDate} >= date('now', '-30 days')`,
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(sql`date(${schoolFeePaymentsSchema.paymentDate})`)
    .orderBy(sql`date(${schoolFeePaymentsSchema.paymentDate})`)
    .all();
}

/**
 * FIX (Bug 4): Sort comparator was broken — || with localeCompare and a
 * ternary never returned 0, so equal elements were never considered equal
 * and ordering was non-deterministic for same class names.
 *
 * Also fixes the double-count bug: payments are aggregated per fee structure
 * first (Step 2), then class-section totals are assembled in JS (Step 3).
 */
export async function getFeesClassSectionBreakdown(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const structures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      classSectionId: schoolFeeStructuresSchema.classSectionId,
    })
    .from(schoolFeeStructuresSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolFeeStructuresSchema.classSectionId, schoolClassSectionsSchema.id)
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
      and(
        academicYearId
          ? eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
          : undefined,
        classSectionId
          ? eq(schoolFeeStructuresSchema.classSectionId, classSectionId)
          : undefined
      )
    )
    .all();

  if (structures.length === 0) return [];

  const structureIds = structures.map((s: any) => s.id);

  const paymentTotals = await db
    .select({
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        inArray(schoolFeePaymentsSchema.feeStructureId, structureIds),
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(schoolFeePaymentsSchema.feeStructureId)
    .all();

  const paidByStructure = new Map<number, number>(
    paymentTotals.map((r: any) => [r.feeStructureId, r.totalPaid])
  );

  const breakdownMap = new Map<
    string,
    {
      className: string;
      sectionName: string;
      totalAssigned: number;
      totalCollected: number;
    }
  >();

  for (const s of structures) {
    const key = `${s.className}::${s.sectionName}`;
    if (!breakdownMap.has(key)) {
      breakdownMap.set(key, {
        className: s.className,
        sectionName: s.sectionName,
        totalAssigned: 0,
        totalCollected: 0,
      });
    }
    const entry = breakdownMap.get(key)!;
    entry.totalAssigned += s.amount;
    entry.totalCollected += paidByStructure.get(s.id) ?? 0;
  }

  // FIX (Bug 4): Correct two-key sort comparator.
  // localeCompare returns -1 | 0 | 1. The previous `|| ternary ? -1 : 1`
  // pattern never returned 0 for equal elements, making the secondary sort
  // non-deterministic. The correct pattern is an explicit cascade.
  return Array.from(breakdownMap.values()).sort((a, b) => {
    const classComp = a.className.localeCompare(b.className);
    if (classComp !== 0) return classComp;
    return a.sectionName.localeCompare(b.sectionName);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an inclusive list of "YYYY-MM" strings between startMonth and
 * endMonth. Safety cap: 36 months (3 academic years) to prevent runaway inserts.
 */
function generateMonthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  const [startY, startM] = startMonth.split("-").map(Number);
  const [endY, endM] = endMonth.split("-").map(Number);
  let y = startY;
  let m = startM;

  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (months.length > 36) break; // safety cap
  }

  return months;
}


// ===========

// ─────────────────────────────────────────────────────────────────────────────
// FEE RECEIPT (batch-aware, ownership-checked)
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestingUserContext {
  id: number;
  role?: string;
  permissions: string[];
}

export interface FeeReceiptLineItem {
  id: number;
  receiptNumber: string;
  source: "STRUCTURE" | "ASSIGNMENT";
  feeType: string;
  feeMonth: string | null;
  originalAmount: number;
  concessionAmount: number;
  effectiveAmount: number;
  amountPaid: number;
  isVoid: boolean;
}

export interface FeeReceiptData {
  batchId: string | null;
  primaryReceiptNumber: string;
  paymentDate: string;
  paymentMethod: "CASH" | "CHECK" | "BANK_TRANSFER";
  notes: string | null;
  totalPaid: number;
  items: FeeReceiptLineItem[];
  recordedByName: string | null;
  student: {
    name: string;
    rollNumber: string | null;
    className: string;
    sectionName: string;
    academicYearName: string;
  };
  school: {
    name: string;
    shortName: string | null;
    logoUrl: string | null;
    addressLineOne: string;
    addressLineTwo: string;
    phone: string;
    email: string;
  };
}

const STAFF_FEE_PERMISSIONS = [
  "fees.report",
  "fees.payments.record",
  "fees.structures.manage",
  "fees.ledger.view",
];

export async function getFeeReceipt(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  paymentId: number,
  requestingUser: RequestingUserContext
): Promise<FeeReceiptData> {
  const db = await getSchoolDB(env, schoolCode);

  // ── 1. Load the anchor payment row ────────────────────────────────────────
  const anchor = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      enrollmentId: schoolFeePaymentsSchema.enrollmentId,
      batchId: schoolFeePaymentsSchema.batchId,
    })
    .from(schoolFeePaymentsSchema)
    .where(eq(schoolFeePaymentsSchema.id, paymentId))
    .get();

  if (!anchor) throw new Error("Payment not found");

  // ── 2. Resolve enrollment → student, for ownership check + header info ────
  const enrollment = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      academicYearName: schoolAcademicYearsSchema.name,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolStudentEnrollmentsSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .innerJoin(schoolClassesSchema, eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id))
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(schoolStudentEnrollmentsSchema.academicYearId, schoolAcademicYearsSchema.id)
    )
    .where(eq(schoolStudentEnrollmentsSchema.id, anchor.enrollmentId))
    .get();

  if (!enrollment) throw new Error("Enrollment not found for this payment");

  // ── 3. Ownership / permission check ────────────────────────────────────────
  const isStaff = requestingUser.permissions.some(
    (p) => p === "*" || STAFF_FEE_PERMISSIONS.includes(p)
  );

  if (!isStaff) {
    const canViewOwn = requestingUser.permissions.includes("fees.student.view");
    const canViewChild = requestingUser.permissions.includes("fees.parent.view");
    let authorised = false;

    if (canViewOwn && requestingUser.id === enrollment.studentId) {
      authorised = true;
    } else if (canViewChild) {
      const relationship = await db
        .select({ studentId: studentParentsSchema.studentId })
        .from(studentParentsSchema)
        .where(
          and(
            eq(studentParentsSchema.parentId, requestingUser.id),
            eq(studentParentsSchema.studentId, enrollment.studentId)
          )
        )
        .get();
      authorised = !!relationship;
    }

    if (!authorised) {
      throw new Error("Unauthorized: you do not have access to this receipt");
    }
  }

  // ── 4. Expand to the full batch (or just this row if batchId is null) ─────
  const batchCondition = anchor.batchId
    ? eq(schoolFeePaymentsSchema.batchId, anchor.batchId)
    : eq(schoolFeePaymentsSchema.id, anchor.id);

  const paymentRows = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      studentFeeAssignmentId: schoolFeePaymentsSchema.studentFeeAssignmentId,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      paymentMethod: schoolFeePaymentsSchema.paymentMethod,
      paymentDate: schoolFeePaymentsSchema.paymentDate,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      notes: schoolFeePaymentsSchema.notes,
      isVoid: schoolFeePaymentsSchema.isVoid,
      recordedBy: schoolFeePaymentsSchema.recordedBy,
      batchId: schoolFeePaymentsSchema.batchId,
    })
    .from(schoolFeePaymentsSchema)
    .where(and(eq(schoolFeePaymentsSchema.enrollmentId, anchor.enrollmentId), batchCondition))
    .orderBy(schoolFeePaymentsSchema.id)
    .all();

  if (paymentRows.length === 0) throw new Error("Payment not found");

  // ── 5. Resolve fee-type / month / original-amount context per row ─────────
  const structureIds = paymentRows
    .map((p: any) => p.feeStructureId)
    .filter((id: any): id is number => id !== null);
  const assignmentIds = paymentRows
    .map((p: any) => p.studentFeeAssignmentId)
    .filter((id: any): id is number => id !== null);

  const structures = structureIds.length
    ? await db
        .select({
          id: schoolFeeStructuresSchema.id,
          feeType: schoolFeeStructuresSchema.feeType,
          feeMonth: schoolFeeStructuresSchema.feeMonth,
          amount: schoolFeeStructuresSchema.amount,
        })
        .from(schoolFeeStructuresSchema)
        .where(inArray(schoolFeeStructuresSchema.id, structureIds))
        .all()
    : [];

  const assignments = assignmentIds.length
    ? await db
        .select({
          id: schoolStudentFeeAssignmentsSchema.id,
          feeType: schoolStudentFeeAssignmentsSchema.feeType,
          feeMonth: schoolStudentFeeAssignmentsSchema.feeMonth,
          amount: schoolStudentFeeAssignmentsSchema.amount,
        })
        .from(schoolStudentFeeAssignmentsSchema)
        .where(inArray(schoolStudentFeeAssignmentsSchema.id, assignmentIds))
        .all()
    : [];

  const structureMap = new Map(structures.map((s: any) => [s.id, s]));
  const assignmentMap = new Map(assignments.map((a: any) => [a.id, a]));

  // Concessions aren't versioned historically — surfacing the CURRENTLY
  // active concession per fee is a reasonable, clearly-labeled approximation
  // for receipt display, matching how the rest of the fees module treats them.
  const structureConcessions = structureIds.length
    ? await db
        .select({
          feeStructureId: schoolFeeConcessionsSchema.feeStructureId,
          concessionType: schoolFeeConcessionsSchema.concessionType,
          concessionValue: schoolFeeConcessionsSchema.concessionValue,
        })
        .from(schoolFeeConcessionsSchema)
        .where(
          and(
            eq(schoolFeeConcessionsSchema.enrollmentId, anchor.enrollmentId),
            inArray(schoolFeeConcessionsSchema.feeStructureId, structureIds)
          )
        )
        .all()
    : [];

  const assignmentConcessions = assignmentIds.length
    ? await db
        .select({
          studentFeeAssignmentId: schoolFeeConcessionsSchema.studentFeeAssignmentId,
          concessionType: schoolFeeConcessionsSchema.concessionType,
          concessionValue: schoolFeeConcessionsSchema.concessionValue,
        })
        .from(schoolFeeConcessionsSchema)
        .where(
          and(
            eq(schoolFeeConcessionsSchema.enrollmentId, anchor.enrollmentId),
            inArray(schoolFeeConcessionsSchema.studentFeeAssignmentId, assignmentIds)
          )
        )
        .all()
    : [];

  const structureConcessionMap = new Map(
    structureConcessions.map((c: any) => [c.feeStructureId, c])
  );
  const assignmentConcessionMap = new Map(
    assignmentConcessions.map((c: any) => [c.studentFeeAssignmentId, c])
  );

  // ── 6. Assemble line items ─────────────────────────────────────────────────
  const items: FeeReceiptLineItem[] = paymentRows.map((p: any) => {
    if (p.feeStructureId) {
      const s = structureMap.get(p.feeStructureId);
      const conc = structureConcessionMap.get(p.feeStructureId) ?? null;
      const originalAmount = s?.amount ?? p.amountPaid;
      const concessionAmount = conc
        ? conc.concessionType === "FIXED"
          ? conc.concessionValue
          : Math.floor((originalAmount * conc.concessionValue) / 100)
        : 0;
      return {
        id: p.id,
        receiptNumber: p.receiptNumber,
        source: "STRUCTURE" as const,
        feeType: s?.feeType ?? "Fee",
        feeMonth: s?.feeMonth ?? null,
        originalAmount,
        concessionAmount,
        effectiveAmount: Math.max(0, originalAmount - concessionAmount),
        amountPaid: p.amountPaid,
        isVoid: p.isVoid,
      };
    }
    const a = p.studentFeeAssignmentId ? assignmentMap.get(p.studentFeeAssignmentId) : null;
    const conc = p.studentFeeAssignmentId
      ? assignmentConcessionMap.get(p.studentFeeAssignmentId) ?? null
      : null;
    const originalAmount = a?.amount ?? p.amountPaid;
    const concessionAmount = conc
      ? conc.concessionType === "FIXED"
        ? conc.concessionValue
        : Math.floor((originalAmount * conc.concessionValue) / 100)
      : 0;
    return {
      id: p.id,
      receiptNumber: p.receiptNumber,
      source: "ASSIGNMENT" as const,
      feeType: a?.feeType ?? "Custom Fee",
      feeMonth: a?.feeMonth ?? null,
      originalAmount,
      concessionAmount,
      effectiveAmount: Math.max(0, originalAmount - concessionAmount),
      amountPaid: p.amountPaid,
      isVoid: p.isVoid,
    };
  });

  // ── 7. Recorded-by staff name ────────────────────────────────────────────
  const recordedByIds = [...new Set(paymentRows.map((p: any) => p.recordedBy))];
  const recordedByRows = recordedByIds.length
    ? await db
        .select({ id: schoolUsersSchema.id, name: schoolUsersSchema.name })
        .from(schoolUsersSchema)
        .where(inArray(schoolUsersSchema.id, recordedByIds))
        .all()
    : [];
  const recordedByName = recordedByRows[0]?.name ?? null;

  // ── 8. School branding ────────────────────────────────────────────────────
  const school = await getSchoolBrandingForReceipt(db);

  const primary = paymentRows[0];
  const totalPaid = items.filter((i) => !i.isVoid).reduce((s, i) => s + i.amountPaid, 0);

  return {
    batchId: anchor.batchId,
    primaryReceiptNumber: primary.receiptNumber,
    paymentDate: primary.paymentDate,
    paymentMethod: primary.paymentMethod,
    notes: primary.notes,
    totalPaid,
    items,
    recordedByName,
    student: {
      name: enrollment.studentName,
      rollNumber: enrollment.rollNumber ?? null,
      className: enrollment.className,
      sectionName: enrollment.sectionName,
      academicYearName: enrollment.academicYearName,
    },
    school,
  };
}

// ── School branding for receipts ─────────────────────────────────────────
// Takes the already-open db handle from the caller instead of (env, schoolCode)
// — getFeeReceipt() already has a live connection via getSchoolDB(), so
// re-resolving the tenant DB here would open a second redundant connection
// to the same database for no reason. Queries the schools table directly
// (single-row table, id always 1 per tenant DB — see schoolsSchema comment).
// Falls back to empty strings only if the row is somehow missing, so a
// broken receipt never throws.
async function getSchoolBrandingForReceipt(
  db: any
): Promise<FeeReceiptData["school"]> {
  const school = await db
    .select({
      name: schoolsSchema.name,
      shortName: schoolsSchema.shortName,
      logoUrl: schoolsSchema.logoUrl,
      addressLineOne: schoolsSchema.addressLineOne,
      addressLineTwo: schoolsSchema.addressLineTwo,
      phone: schoolsSchema.phone,
      email: schoolsSchema.email,
    })
    .from(schoolsSchema)
    .get();

  return {
    name: school?.name ?? "",
    shortName: school?.shortName || null,
    logoUrl: school?.logoUrl || null,
    addressLineOne: school?.addressLineOne ?? "",
    addressLineTwo: school?.addressLineTwo ?? "",
    phone: school?.phone ?? "",
    email: school?.email ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS FOR A SINGLE FEE ITEM (powers FeeItemPaymentHistoryDialogComponent)
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeItemPaymentRow {
  id: number;
  receiptNumber: string;
  amountPaid: number;
  paymentMethod: "CASH" | "CHECK" | "BANK_TRANSFER";
  paymentDate: string;
  isVoid: boolean;
  batchId: string | null;
  /** True when this payment's batch also covers other fee items — i.e. it
   *  was collected together with something else in one checkout. */
  hasSiblingsOutsideThisItem: boolean;
}

export async function getPaymentsForFeeItem(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number,
  source: "STRUCTURE" | "ASSIGNMENT",
  feeId: number
): Promise<FeeItemPaymentRow[]> {
  const db = await getSchoolDB(env, schoolCode);

  const condition =
    source === "STRUCTURE"
      ? eq(schoolFeePaymentsSchema.feeStructureId, feeId)
      : eq(schoolFeePaymentsSchema.studentFeeAssignmentId, feeId);

  const rows = await db
    .select({
      id: schoolFeePaymentsSchema.id,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      paymentMethod: schoolFeePaymentsSchema.paymentMethod,
      paymentDate: schoolFeePaymentsSchema.paymentDate,
      isVoid: schoolFeePaymentsSchema.isVoid,
      batchId: schoolFeePaymentsSchema.batchId,
    })
    .from(schoolFeePaymentsSchema)
    .where(and(eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId), condition))
    .orderBy(desc(schoolFeePaymentsSchema.paymentDate), desc(schoolFeePaymentsSchema.id))
    .all();

  if (rows.length === 0) return [];

  // ── Figure out which batches have rows OUTSIDE this fee item ──────────────
  const batchIds = [...new Set(rows.map((r: any) => r.batchId).filter(Boolean))] as string[];

  const totalRowsPerBatchRaw = batchIds.length
    ? await db
        .select({
          batchId: schoolFeePaymentsSchema.batchId,
          count: sql<number>`COUNT(*)`,
        })
        .from(schoolFeePaymentsSchema)
        .where(inArray(schoolFeePaymentsSchema.batchId, batchIds))
        .groupBy(schoolFeePaymentsSchema.batchId)
        .all()
    : [];

  const rowsPerBatchForThisItem = new Map<string, number>();
  rows.forEach((r: any) => {
    if (!r.batchId) return;
    rowsPerBatchForThisItem.set(r.batchId, (rowsPerBatchForThisItem.get(r.batchId) ?? 0) + 1);
  });
  const totalRowsPerBatch = new Map<string, number>(
    totalRowsPerBatchRaw.map((s: any) => [s.batchId, s.count])
  );

  return rows.map((r: any) => ({
    id: r.id,
    receiptNumber: r.receiptNumber,
    amountPaid: r.amountPaid,
    paymentMethod: r.paymentMethod,
    paymentDate: r.paymentDate,
    isVoid: r.isVoid,
    batchId: r.batchId,
    hasSiblingsOutsideThisItem: r.batchId
      ? (totalRowsPerBatch.get(r.batchId) ?? 0) > (rowsPerBatchForThisItem.get(r.batchId) ?? 0)
      : false,
  }));
}

