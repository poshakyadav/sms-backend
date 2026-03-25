import { getSchoolDB } from "../../../db/school-client";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
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
  studentsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { sendTransactionalEmail } from "../../../utils/sendEmail";

// ==================== Create Fee Structure ====================
export async function createFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [newStructure] = await db
    .insert(schoolFeeStructuresSchema)
    .values(data)
    .returning();

  // Return full data with names
  const [fullStructure] = await getFeeStructuresInternal(db, newStructure.id);
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

async function getFeeStructuresInternal(db: any, specificId?: number) {
  const query = db
    .select({
      id: schoolFeeStructuresSchema.id,
      academicYearId: schoolFeeStructuresSchema.academicYearId,
      classId: schoolFeeStructuresSchema.classId,
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
      schoolClassesSchema,
      eq(schoolFeeStructuresSchema.classId, schoolClassesSchema.id)
    )
    .leftJoin(
      schoolClassSectionsSchema,
      eq(schoolFeeStructuresSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .leftJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    );

  if (specificId) {
    return query.where(eq(schoolFeeStructuresSchema.id, specificId)).get();
  }

  return query.orderBy(
    schoolClassesSchema.name,
    schoolSectionsSchema.name,
    schoolFeeStructuresSchema.feeType
  );
}

// ==================== Update Fee Structure ====================
export async function updateFeeStructure(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolFeeStructuresSchema)
    .set(data)
    .where(eq(schoolFeeStructuresSchema.id, id))
    .returning();

  if (!updated) throw new Error("Fee structure not found");

  const [fullStructure] = await getFeeStructuresInternal(db, updated.id);
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
  data: any,
  recordedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const receiptNumber = `REC-${nanoid(8).toUpperCase()}`;

    const [newPayment] = await tx
      .insert(schoolFeePaymentsSchema)
      .values({
        ...data,
        receiptNumber,
        recordedBy,
      })
      .returning();

    // Send receipt email (to student/parent)
    const enrollment = await tx
      .select()
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.id, data.enrollmentId))
      .get();

    if (!enrollment) throw new Error("Enrollment not found");

    const student = await tx
      .select()
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.id, enrollment.studentId))
      .get();

    if (!student) throw new Error("Student not found");

    const emailData: BrevoSendEmailRequest = {
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: student.email, name: student.name }],
      subject: `Fee Receipt - ${receiptNumber}`,
      htmlContent: `
        <h2>Fee Payment Receipt</h2>
        <p>Amount: ${data.amountPaid}</p>
        <p>Date: ${newPayment.paymentDate}</p>
        <p>Method: ${data.paymentMethod}</p>
        <p>Receipt: ${receiptNumber}</p>
      `,
    };

    await sendTransactionalEmail(env, emailData).catch((err) =>
      console.error("Receipt email failed:", err)
    );

    return {
      payment: newPayment,
      message: "Payment recorded and receipt sent",
    };
  });
}

// ==================== Get Student Ledger (FIXED) ====================
export async function getStudentLedger(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  academicYearId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollments = await db
    .select()
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId));

  const ledgers = [];
  for (const e of enrollments) {
    if (academicYearId && e.academicYearId !== academicYearId) continue;

    // FIXED: Simple & correct fee lookup using classSectionId
    const fees = await db
      .select()
      .from(schoolFeeStructuresSchema)
      .where(
        or(
          isNull(schoolFeeStructuresSchema.classSectionId), // class-level fees
          eq(schoolFeeStructuresSchema.classSectionId, e.classSectionId) // section-specific fees
        )
      );

    const payments = await db
      .select()
      .from(schoolFeePaymentsSchema)
      .where(eq(schoolFeePaymentsSchema.enrollmentId, e.id));

    let totalDue = 0;
    let totalPaid = 0;
    fees.forEach((f) => (totalDue += f.amount));
    payments.forEach((p) => (totalPaid += p.amountPaid));

    ledgers.push({
      yearId: e.academicYearId,
      totalDue,
      totalPaid,
      balance: totalDue - totalPaid,
      details: { fees, payments },
    });
  }

  return ledgers;
}

// ==================== Get Fee Report (FIXED - now by classSectionId) ====================
export async function getFeeReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const where = [];
  if (data.classSectionId) {
    where.push(
      eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
    );
  }

  const enrollments = await db
    .select()
    .from(schoolStudentEnrollmentsSchema)
    .where(where.length ? and(...where) : undefined);

  const report = [];

  for (const e of enrollments) {
    const ledgers = await getStudentLedger(
      env,
      schoolCode,
      e.studentId,
      e.academicYearId
    );
    const ledger = ledgers[0];
    if (!ledger) continue;

    if (data.overdueOnly && ledger.balance <= 0) continue;

    report.push({
      studentId: e.studentId,
      balance: ledger.balance,
      totalDue: ledger.totalDue,
      totalPaid: ledger.totalPaid,
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

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No current academic year found");

  const students = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      enrollmentId: schoolStudentEnrollmentsSchema.id,
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
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber);

  // Add balance for each student
  for (const s of students) {
    const ledger = await getStudentLedger(
      env,
      schoolCode,
      s.id,
      currentYear.id
    );
    (s as any).balance = ledger[0]?.balance || 0;
    (s as any).totalAssigned = ledger[0]?.totalDue || 0;
  }

  return students;
}

// ==================== Get Due Fees for Enrollment (FIXED) ====================
export async function getDueFeesForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  enrollmentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.id, enrollmentId))
    .get();

  if (!enrollment) throw new Error("Enrollment not found");

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
      or(
        isNull(schoolFeeStructuresSchema.classSectionId),
        eq(schoolFeeStructuresSchema.classSectionId, enrollment.classSectionId)
      )
    );

  const payments = await db
    .select({
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
    })
    .from(schoolFeePaymentsSchema)
    .where(eq(schoolFeePaymentsSchema.enrollmentId, enrollmentId));

  const paidMap = new Map<number, number>();
  payments.forEach((p) => {
    paidMap.set(
      p.feeStructureId,
      (paidMap.get(p.feeStructureId) || 0) + p.amountPaid
    );
  });

  const enrichedFees = fees.map((fee) => {
    const paid = paidMap.get(fee.id) || 0;
    return { ...fee, paid, remaining: fee.amount - paid };
  });

  const totalDue = enrichedFees.reduce((sum, f) => sum + f.amount, 0);
  const totalPaid = enrichedFees.reduce((sum, f) => sum + f.paid, 0);
  const balanceDue = totalDue - totalPaid;

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
