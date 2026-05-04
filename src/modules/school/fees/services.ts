import { getSchoolDB } from "../../../db/school-client";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
  studentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { sendTransactionalEmail } from "../../../utils/sendEmail";

// ==================== Student: View Own Fees ====================
// Called by GET /school/fees/student/my-fees
// userId comes from the validated JWT — no override possible.

export interface StudentFeeOverview {
  academicYearId: number;
  academicYearName: string;
  className: string;
  sectionName: string;
  rollNumber: string | null;
  totalDue: number;
  totalPaid: number;
  balance: number;
  collectionRate: number; // 0–100
  feeBreakdown: StudentFeeItem[];
  recentPayments: StudentPaymentItem[];
}

export interface StudentFeeItem {
  id: number;
  feeType: string;
  amount: number;
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

export async function getStudentOwnFees(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentUserId: number,
  academicYearId?: number
): Promise<StudentFeeOverview[]> {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Resolve academic year(s) — if not specified, return ALL years for full history
  let yearCondition: any = undefined;
  if (academicYearId) {
    yearCondition = eq(
      schoolStudentEnrollmentsSchema.academicYearId,
      academicYearId
    );
  }

  // 2. Fetch all enrollments for this student
  const enrollments = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      academicYearName: schoolAcademicYearsSchema.name,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isCurrent: schoolAcademicYearsSchema.isCurrent,
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
        yearCondition
      )
    )
    .orderBy(
      desc(schoolAcademicYearsSchema.isCurrent),
      schoolAcademicYearsSchema.name
    );

  if (enrollments.length === 0) return [];

  const overviews: StudentFeeOverview[] = [];

  for (const enrollment of enrollments) {
    // 3. Fee structures for this class-section + year
    const feeStructures = await db
      .select({
        id: schoolFeeStructuresSchema.id,
        feeType: schoolFeeStructuresSchema.feeType,
        amount: schoolFeeStructuresSchema.amount,
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
      );

    // 4. Payments for this enrollment
    const payments = await db
      .select({
        id: schoolFeePaymentsSchema.id,
        feeStructureId: schoolFeePaymentsSchema.feeStructureId,
        amountPaid: schoolFeePaymentsSchema.amountPaid,
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
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      )
      .orderBy(desc(schoolFeePaymentsSchema.paymentDate));

    // 5. Build paid-per-fee-structure map
    const paidMap = new Map<number, number>();
    payments.forEach((p) => {
      paidMap.set(
        p.feeStructureId,
        (paidMap.get(p.feeStructureId) ?? 0) + p.amountPaid
      );
    });

    // 6. Enrich fee items with status
    const today = new Date().toISOString().split("T")[0];
    const feeBreakdown: StudentFeeItem[] = feeStructures.map((fee) => {
      const amountPaid = paidMap.get(fee.id) ?? 0;
      const balance = fee.amount - amountPaid;
      let status: StudentFeeItem["status"];
      if (balance <= 0) {
        status = "PAID";
      } else if (amountPaid > 0) {
        status = "PARTIAL";
      } else if (fee.dueDate && fee.dueDate < today) {
        status = "OVERDUE";
      } else {
        status = "PENDING";
      }
      return {
        id: fee.id,
        feeType: fee.feeType,
        amount: fee.amount,
        dueDate: fee.dueDate ?? null,
        isMandatory: fee.isMandatory,
        description: fee.description ?? null,
        amountPaid,
        balance,
        status,
      };
    });

    const totalDue = feeBreakdown.reduce((s, f) => s + f.amount, 0);
    const totalPaid = feeBreakdown.reduce((s, f) => s + f.amountPaid, 0);
    const balance = totalDue - totalPaid;
    const collectionRate =
      totalDue > 0 ? Math.round((totalPaid / totalDue) * 100) : 100;

    // 7. Recent payments (latest 10 for the card)
    const recentPayments: StudentPaymentItem[] = payments
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        amountPaid: p.amountPaid,
        paymentMethod: p.paymentMethod as StudentPaymentItem["paymentMethod"],
        receiptNumber: p.receiptNumber,
        feeType: p.feeType,
        notes: p.notes ?? null,
      }));

    overviews.push({
      academicYearId: enrollment.academicYearId,
      academicYearName: enrollment.academicYearName,
      className: enrollment.className,
      sectionName: enrollment.sectionName,
      rollNumber: enrollment.rollNumber ?? null,
      totalDue,
      totalPaid,
      balance,
      collectionRate,
      feeBreakdown,
      recentPayments,
    });
  }

  return overviews;
}

// ==================== Parent: View Child's Fees ====================
// Called by GET /school/fees/parent/child-fees
// childStudentId comes from X-Active-Child-Id header (set by auth-interceptor).
// The parent's own userId (from JWT) is used to verify the parent-child link.

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

  // 1. Verify parent → child relationship (security gate)
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

  if (!relationship) {
    throw new Error("Unauthorized: no parent-child relationship found");
  }

  // 2. Fetch student display info
  const studentInfo = await db
    .select({
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, childStudentId))
    .get();

  if (!studentInfo) throw new Error("Student not found");

  // 3. Reuse student fee logic (same implementation, different user ID)
  const overviews = await getStudentOwnFees(
    env,
    schoolCode,
    childStudentId,
    academicYearId
  );

  // 4. Decorate with student identity for parent display
  return overviews.map((o) => ({
    ...o,
    studentName: studentInfo.name,
    studentEmail: studentInfo.email,
    studentId: childStudentId,
  }));
}

// ==================== Create Fee Structure ====================
export async function createFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  // Drizzle + SQLite (libSQL/Turso): .returning() returns an array.
  // Destructure safely with index access to avoid "is not iterable" if the
  // driver ever returns a plain object in some edge-case.
  const returning = await db
    .insert(schoolFeeStructuresSchema)
    .values(data)
    .returning();

  const newStructure = Array.isArray(returning) ? returning[0] : returning;

  if (!newStructure) throw new Error("Insert failed — no row returned");

  // Fetch the full denormalised shape (with class/section names) for the response
  const fullStructure = await getFeeStructureById(db, newStructure.id);
  return { structure: fullStructure, message: "Fee structure created" };
}

// ==================== Get Fee Structures (with nice names) ====================
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
      schoolFeeStructuresSchema.feeType
    );
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
    .get(); // returns single row | undefined

  if (!row) throw new Error(`Fee structure ${id} not found`);
  return row;
}

// ==================== Update Fee Structure ====================
export async function updateFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const returning = await db
    .update(schoolFeeStructuresSchema)
    .set(data)
    .where(eq(schoolFeeStructuresSchema.id, id))
    .returning();

  const updated = Array.isArray(returning) ? returning[0] : returning;

  if (!updated) throw new Error("Fee structure not found");

  const fullStructure = await getFeeStructureById(db, updated.id);
  return { structure: fullStructure, message: "Fee structure updated" };
}

// ==================== Delete Fee Structure ====================
export async function deleteFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const used = await db
    .select()
    .from(schoolFeePaymentsSchema)
    .where(eq(schoolFeePaymentsSchema.feeStructureId, id))
    .limit(1)
    .get();

  if (used) throw new Error("Cannot delete fee structure with payments");

  const [deleted] = await db
    .delete(schoolFeeStructuresSchema)
    .where(eq(schoolFeeStructuresSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Fee structure not found");

  return { message: "Fee structure deleted" };
}

// ==================== Record Fee Payment ====================
export async function recordFeePayment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    enrollmentId: number;
    feeStructureId?: number;
    amountPaid?: number;
    paymentMethod: "CASH" | "CHECK" | "BANK_TRANSFER";
    notes?: string;
    // New: for distributed payments across multiple fee structures
    payments?: Array<{ feeStructureId: number; amountPaid: number }>;
  },
  recordedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Normalize to a payments array for uniform processing
  const paymentsToProcess: Array<{
    feeStructureId: number;
    amountPaid: number;
  }> =
    data.payments && data.payments.length > 0
      ? data.payments
      : data.feeStructureId && data.amountPaid
      ? [{ feeStructureId: data.feeStructureId, amountPaid: data.amountPaid }]
      : [];

  if (paymentsToProcess.length === 0) {
    throw new Error("No payment data provided");
  }

  return await db.transaction(async (tx: any) => {
    // ── 1. Verify enrollment ────────────────────────────────────────────────
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
      throw new Error("Cannot record payment for an inactive enrollment");

    const insertedPayments: any[] = [];
    const receiptNumbers: string[] = [];

    // ── 2. Process each payment ─────────────────────────────────────────────
    for (const p of paymentsToProcess) {
      if (p.amountPaid <= 0) continue; // Skip zero amounts

      // Verify fee structure exists and belongs to this class-section
      const feeStructure = await tx
        .select({
          id: schoolFeeStructuresSchema.id,
          amount: schoolFeeStructuresSchema.amount,
          classSectionId: schoolFeeStructuresSchema.classSectionId,
          feeType: schoolFeeStructuresSchema.feeType,
        })
        .from(schoolFeeStructuresSchema)
        .where(eq(schoolFeeStructuresSchema.id, p.feeStructureId))
        .get();

      if (!feeStructure)
        throw new Error(`Fee structure ${p.feeStructureId} not found`);

      if (feeStructure.classSectionId !== enrollment.classSectionId) {
        throw new Error(
          `Fee structure does not belong to this student's class-section`
        );
      }

      // Calculate already-paid for this specific fee structure + enrollment
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
      const remainingForStructure = feeStructure.amount - alreadyPaid;

      if (p.amountPaid > remainingForStructure) {
        throw new Error(
          `Payment of ₹${p.amountPaid.toLocaleString(
            "en-IN"
          )} exceeds the remaining balance of ₹${remainingForStructure.toLocaleString(
            "en-IN"
          )} for ${feeStructure.feeType}. ` +
            `Already paid: ₹${alreadyPaid.toLocaleString(
              "en-IN"
            )} of ₹${feeStructure.amount.toLocaleString("en-IN")}.`
        );
      }

      const receiptNumber = `REC-${nanoid(8).toUpperCase()}`;
      receiptNumbers.push(receiptNumber);

      const [newPayment] = await tx
        .insert(schoolFeePaymentsSchema)
        .values({
          enrollmentId: data.enrollmentId,
          feeStructureId: p.feeStructureId,
          amountPaid: p.amountPaid,
          paymentMethod: data.paymentMethod,
          notes: data.notes ?? null,
          receiptNumber,
          recordedBy,
        })
        .returning();

      insertedPayments.push({ ...newPayment, feeType: feeStructure.feeType });
    }

    if (insertedPayments.length === 0) {
      throw new Error("No valid payments to process");
    }

    // ── 3. Calculate updated totals for response ────────────────────────────
    const totalPaidNow = insertedPayments.reduce(
      (sum: number, p: any) => sum + p.amountPaid,
      0
    );

    // ── 4. Send receipt email (non-blocking) ──────────────────────────────
    const student = await tx
      .select({ name: schoolUsersSchema.name, email: schoolUsersSchema.email })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, enrollment.studentId))
      .get();

    if (student) {
      const paymentLines = insertedPayments
        .map(
          (p: any) =>
            `<li>${p.feeType}: ₹${p.amountPaid.toLocaleString(
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
          <p><strong>Total Amount Paid:</strong> ₹${totalPaidNow.toLocaleString(
            "en-IN"
          )}</p>
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

    // Return the first payment for backward compatibility, plus all receipts
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

// ==================== Get Student Ledger  ====================
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
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId));

  const ledgers = [];

  for (const e of enrollments) {
    if (academicYearId && e.academicYearId !== academicYearId) continue;

    const fees = await db
      .select({
        id: schoolFeeStructuresSchema.id,
        feeType: schoolFeeStructuresSchema.feeType,
        amount: schoolFeeStructuresSchema.amount,
        dueDate: schoolFeeStructuresSchema.dueDate,
        isMandatory: schoolFeeStructuresSchema.isMandatory,
        description: schoolFeeStructuresSchema.description,
      })
      .from(schoolFeeStructuresSchema)
      .where(eq(schoolFeeStructuresSchema.classSectionId, e.classSectionId));

    const payments = await db
      .select({
        id: schoolFeePaymentsSchema.id,
        paymentDate: schoolFeePaymentsSchema.paymentDate,
        amountPaid: schoolFeePaymentsSchema.amountPaid,
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
      .where(eq(schoolFeePaymentsSchema.enrollmentId, e.id))
      .orderBy(desc(schoolFeePaymentsSchema.paymentDate));

    let totalDue = 0;
    let totalPaid = 0;
    fees.forEach((f) => (totalDue += f.amount));
    payments.forEach((p) => (totalPaid += p.amountPaid));

    ledgers.push({
      yearId: e.academicYearId,
      academicYearName: e.academicYearName,
      studentName: e.studentName,
      className: e.className,
      sectionName: e.sectionName,
      rollNumber: e.rollNumber,
      totalDue,
      totalPaid,
      balance: totalDue - totalPaid,
      details: { fees, payments },
    });
  }

  return ledgers;
}

// ── Public shape returned by getFeeReport ─────────────────────────────────────

export interface FeeReportRow {
  studentId: number;
  enrollmentId: number;
  studentName: string;
  rollNumber: string | null;
  className: string;
  sectionName: string;
  academicYearName: string;
  totalDue: number;
  totalPaid: number;
  balance: number;
}

// ── Route-level validation shape ──────────────────────────────────────────────

export interface FeeReportFilter {
  /** Required — report is always scoped to one class-section. */
  classSectionId: number;
  /** Optional — defaults to the current academic year. */
  academicYearId?: number;
  /** When true, only returns students with balance > 0 */
  overdueOnly?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// getFeeReport  (DROP-IN REPLACEMENT)
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeeReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: FeeReportFilter
): Promise<FeeReportRow[]> {
  const db = await getSchoolDB(env, schoolCode);

  // ── 1. Resolve academic year ───────────────────────────────────────────────
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

  // ── 2. Fetch active enrollments for the class-section ─────────────────────
  //       Join through studentsSchema to guarantee only STUDENT role users.
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
    // join → students (ensures only STUDENT primary-role users)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    // join → school_users for display name / email
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    // join → class_sections → classes → sections (for display names)
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
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name);

  if (enrollments.length === 0) return [];

  // ── 3. Fetch total fee assigned for this class-section + academic year ─────
  //       One query, not per-student.
  const feeSum = await db
    .select({
      totalAssigned: sql<number>`COALESCE(SUM(${schoolFeeStructuresSchema.amount}), 0)`,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, data.classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, academicYearId)
      )
    )
    .get();

  const totalDuePerStudent = feeSum?.totalAssigned ?? 0;

  // ── 4. Fetch total payments per enrollment in one query ────────────────────
  const enrollmentIds = enrollments.map((e) => e.enrollmentId);

  // SQLite inArray with empty array would throw — guard already above.
  const paymentRows = await db
    .select({
      enrollmentId: schoolFeePaymentsSchema.enrollmentId,
      totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        sql`${schoolFeePaymentsSchema.enrollmentId} IN (${sql.join(
          enrollmentIds.map((id) => sql`${id}`),
          sql`, `
        )})`,
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(schoolFeePaymentsSchema.enrollmentId);

  const paidMap = new Map<number, number>(
    paymentRows.map((r) => [r.enrollmentId, r.totalPaid])
  );

  // ── 5. Assemble report rows ────────────────────────────────────────────────
  const report: FeeReportRow[] = [];

  for (const e of enrollments) {
    const totalPaid = paidMap.get(e.enrollmentId) ?? 0;
    const balance = totalDuePerStudent - totalPaid;

    if (data.overdueOnly && balance <= 0) continue;

    report.push({
      studentId: e.studentId,
      enrollmentId: e.enrollmentId,
      studentName: e.studentName,
      rollNumber: e.rollNumber ?? null,
      className: e.className,
      sectionName: e.sectionName,
      academicYearName: e.academicYearName,
      totalDue: totalDuePerStudent,
      totalPaid,
      balance,
    });
  }

  return report;
}

// ==================== Get Students by Class Section (FIXED) ====================
export async function getStudentsByClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── 1. Resolve current academic year (single lookup) ──────────────────────
  const currentYear = await db
    .select({ id: schoolAcademicYearsSchema.id })
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No current academic year found");

  // ── 2. Fetch all active enrollments for this class-section + year ──────────
  //       Join through studentsSchema to guarantee only STUDENT role users.
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
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name);

  if (enrollments.length === 0) return [];

  // ── 3. Total fees assigned for this class-section + year (ONE query) ───────
  //       All students in the same class-section share the same fee structures,
  //       so a single SUM is correct for every student.
  const feeSum = await db
    .select({
      totalAssigned: sql<number>`COALESCE(SUM(${schoolFeeStructuresSchema.amount}), 0)`,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(schoolFeeStructuresSchema.classSectionId, classSectionId),
        eq(schoolFeeStructuresSchema.academicYearId, currentYear.id)
      )
    )
    .get();

  const totalAssignedPerStudent = feeSum?.totalAssigned ?? 0;

  // ── 4. Total payments per enrollment (ONE grouped query) ───────────────────
  const enrollmentIds = enrollments.map((e) => e.enrollmentId);

  const paymentRows = await db
    .select({
      enrollmentId: schoolFeePaymentsSchema.enrollmentId,
      totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        sql`${schoolFeePaymentsSchema.enrollmentId} IN (${sql.join(
          enrollmentIds.map((id) => sql`${id}`),
          sql`, `
        )})`,
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .groupBy(schoolFeePaymentsSchema.enrollmentId);

  const paidMap = new Map<number, number>(
    paymentRows.map((r) => [r.enrollmentId, r.totalPaid])
  );

  // ── 5. Assemble final list (pure JS, zero extra queries) ───────────────────
  return enrollments.map((e) => {
    const totalPaid = paidMap.get(e.enrollmentId) ?? 0;
    const balance = totalAssignedPerStudent - totalPaid;

    return {
      id: e.studentId, // kept as `id` — matches EnrolledStudent interface
      name: e.name,
      email: e.email,
      rollNumber: e.rollNumber ?? null,
      enrollmentId: e.enrollmentId,
      totalAssigned: totalAssignedPerStudent,
      totalPaid,
      balance,
    };
  });
}

// ==================== Get Due Fees for Enrollment (FIXED) ====================
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

  // FIX: Filter by BOTH classSectionId AND academicYearId — no more isNull() fallback
  const fees = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      feeType: schoolFeeStructuresSchema.feeType,
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
    );

  // Only count non-void payments for this enrollment
  const payments = await db
    .select({
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId),
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    );

  const paidMap = new Map<number, number>();
  payments.forEach((p) => {
    paidMap.set(
      p.feeStructureId,
      (paidMap.get(p.feeStructureId) || 0) + p.amountPaid
    );
  });

  // FIX: Return ALL fee structures (including fully paid ones) so the
  // frontend can show the complete breakdown including cleared fees.
  const enrichedFees = fees.map((fee) => {
    const paid = paidMap.get(fee.id) || 0;
    return { ...fee, paid, remaining: Math.max(0, fee.amount - paid) };
  });

  const totalDue = enrichedFees.reduce((sum, f) => sum + f.amount, 0);
  const totalPaid = enrichedFees.reduce((sum, f) => sum + f.paid, 0);
  const balanceDue = Math.max(0, totalDue - totalPaid);

  return { fees: enrichedFees, totalDue, totalPaid, balanceDue };
}

// ==================== Get Payment History for Specific Enrollment ====================
export async function getPaymentsForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolFeePaymentsSchema.id,
      paymentDate: schoolFeePaymentsSchema.paymentDate,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      paymentMethod: schoolFeePaymentsSchema.paymentMethod,
      receiptNumber: schoolFeePaymentsSchema.receiptNumber,
      notes: schoolFeePaymentsSchema.notes,
      feeType: schoolFeeStructuresSchema.feeType, // From join
      dueDate: schoolFeeStructuresSchema.dueDate,
    })
    .from(schoolFeePaymentsSchema)
    .innerJoin(
      schoolFeeStructuresSchema,
      eq(schoolFeePaymentsSchema.feeStructureId, schoolFeeStructuresSchema.id)
    )
    .where(eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId))
    .orderBy(desc(schoolFeePaymentsSchema.paymentDate)); // Latest first
}

// ==================== Fees Dashboard - Main Summary ====================
// ==================== Fees Dashboard - Main Summary ====================
export async function getFeesDashboard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Resolve current year if not provided
  if (!academicYearId) {
    const current = await db
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();
    if (current) academicYearId = current.id;
  }

  // ── 1. Total fee amount assigned ────────────────────────────────────────
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

  // ── 2. Total amount collected ───────────────────────────────────────────
  // Join through enrollments so we can filter by academicYearId / classSectionId.
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
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .get();

  // ── 3. Overdue amount ───────────────────────────────────────────────────
  // SQLite/Drizzle does NOT allow aggregate functions (SUM) inside a WHERE
  // clause — that is what caused the 500 error. The fix: run two lean queries
  // and compute the overdue figure in JS.
  //
  // Step A: fetch all fee structures that are past their due date.
  const overdueStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      amount: schoolFeeStructuresSchema.amount,
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
    );

  let totalOverdue = 0;

  if (overdueStructures.length > 0) {
    // Step B: for each overdue fee structure, sum the non-void payments.
    const overdueIds = overdueStructures.map((s) => s.id);

    const paidPerStructure = await db
      .select({
        feeStructureId: schoolFeePaymentsSchema.feeStructureId,
        totalPaid: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
      })
      .from(schoolFeePaymentsSchema)
      .where(
        and(
          inArray(schoolFeePaymentsSchema.feeStructureId, overdueIds),
          eq(schoolFeePaymentsSchema.isVoid, false)
        )
      )
      .groupBy(schoolFeePaymentsSchema.feeStructureId);

    // Build a lookup map: feeStructureId → totalPaid
    const paidMap = new Map<number, number>(
      paidPerStructure.map((r) => [r.feeStructureId, r.totalPaid])
    );

    // Overdue = structures where amount > total paid so far
    for (const fee of overdueStructures) {
      const paid = paidMap.get(fee.id) ?? 0;
      const remaining = fee.amount - paid;
      if (remaining > 0) {
        totalOverdue += remaining;
      }
    }
  }

  // ── 4. Today's collection ───────────────────────────────────────────────
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

  // ── 5. Derived metrics ──────────────────────────────────────────────────
  const totalAssigned = assignedResult?.totalAssigned ?? 0;
  const totalCollected = collectedResult?.totalCollected ?? 0;
  const totalOutstanding = Math.max(0, totalAssigned - totalCollected);
  const collectionRate =
    totalAssigned > 0 ? Math.round((totalCollected / totalAssigned) * 100) : 0;

  return {
    totalAssigned,
    totalCollected,
    totalOutstanding,
    totalOverdue,
    collectionRate,
    todayCollected: todayResult?.today ?? 0,
    academicYearId,
  };
}

// ==================== Collection Trend (Last 30 Days) ====================
export async function getFeesCollectionTrend(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const trend = await db
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
        sql`${schoolFeePaymentsSchema.paymentDate} >= date('now', '-30 days')`
      )
    )
    .groupBy(sql`date(${schoolFeePaymentsSchema.paymentDate})`)
    .orderBy(sql`date(${schoolFeePaymentsSchema.paymentDate})`);

  return trend;
}

// ==================== Class-Section Breakdown ====================
export async function getFeesClassSectionBreakdown(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  academicYearId?: number,
  classSectionId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const breakdown = await db
    .select({
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      totalAssigned: sql<number>`COALESCE(SUM(${schoolFeeStructuresSchema.amount}), 0)`,
      totalCollected: sql<number>`COALESCE(SUM(${schoolFeePaymentsSchema.amountPaid}), 0)`,
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
    .leftJoin(
      schoolFeePaymentsSchema,
      eq(schoolFeeStructuresSchema.id, schoolFeePaymentsSchema.feeStructureId)
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
    .groupBy(schoolClassesSchema.name, schoolSectionsSchema.name);

  return breakdown;
}
