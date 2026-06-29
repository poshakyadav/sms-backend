// src/modules/school/fees/whatsapp-notify.ts
//
// Fire-and-forget WhatsApp notifications for the fees module.
//
// USAGE in your fee payment service (after recording the payment):
//

import { eq, and } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import { getCommonDB } from "../../../db";
import {
  schoolUsersSchema,
  schoolStudentEnrollmentsSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { schoolsSchema as superSchoolsSchema } from "../../../db/schemas/super";
import { sendFeeReminder, sendFeeReceipt } from "../whatsapp/send-service";
import { SchoolEnv } from "../../../types/common-types";

async function getParentsForEnrollment(
  schoolDb: any,
  enrollmentId: number
): Promise<Array<{ id: number; name: string; phone: string }>> {
  const enrollment = await schoolDb
    .select({ studentId: schoolStudentEnrollmentsSchema.studentId })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.id, enrollmentId))
    .get();

  if (!enrollment) return [];

  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
    })
    .from(studentParentsSchema)
    .leftJoin(
      schoolUsersSchema,
      eq(studentParentsSchema.parentId, schoolUsersSchema.id)
    )
    .where(
      and(
        eq(studentParentsSchema.studentId, enrollment.studentId),
        eq(schoolUsersSchema.isActive, true)
      )
    )
    .all();

  return rows.filter((r: any) => r.id && r.phone);
}

// ── FEE REMINDER ──────────────────────────────────────────────────────────────

interface FeeReminderParams {
  enrollmentId: number;
  studentName: string;
  classSection: string;
  rollNumber: string;
  month: string;            // e.g. "June 2026"
  feeBreakdown: string;     // e.g. "Tuition Fee: ₹3500 | Library Fee: ₹200"
  totalDuePaise: number;    // in paise
  dueDate: string;          // e.g. "10 Jun 2026"
  contact: string;
  feeStructureId?: number;
}

export async function notifyFeeReminder(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: FeeReminderParams
): Promise<void> {
  try {
    if (!(env as any).WHATSAPP_ACCESS_TOKEN) return;

    const schoolDb = await getSchoolDB(env, schoolCode);
    const commonDb = getCommonDB(env);

    const superSchool = await commonDb
      .select({ name: superSchoolsSchema.name })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();
    const schoolName = superSchool?.name ?? schoolCode;

    const parents = await getParentsForEnrollment(schoolDb, params.enrollmentId);
    if (!parents.length) return;

    const totalDueDisplay = (params.totalDuePaise / 100).toLocaleString("en-IN");

    for (const parent of parents) {
      sendFeeReminder(env, schoolCode, {
        parentUserId: parent.id,
        parentName: parent.name || "Parent",
        parentPhone: parent.phone,
        studentName: params.studentName,
        classSection: params.classSection,
        rollNumber: params.rollNumber,
        month: params.month,
        feeBreakdown: params.feeBreakdown,
        totalDue: totalDueDisplay,
        dueDate: params.dueDate,
        schoolName,
        contact: params.contact,
        feeStructureId: params.feeStructureId,
      }).catch((err) =>
        console.error(
          `[WA] Fee reminder failed for parent ${parent.id}:`,
          err.message
        )
      );
    }
  } catch (err: any) {
    console.error("[WA] notifyFeeReminder error:", err.message);
  }
}

// ── FEE RECEIPT ───────────────────────────────────────────────────────────────

interface FeeReceiptParams {
  enrollmentId: number;
  studentName: string;
  classSection: string;
  academicYear: string;
  receiptNumber: string;
  paymentDateDisplay: string;    // e.g. "18 Jun 2026"
  paymentMode: string;           // e.g. "Cash" | "Bank Transfer" | "UPI"
  feesPaidBreakdown: string;     // e.g. "Tuition Fee (June): Rs.3500 | Transport: Rs.800"
  amountPaidPaise: number;
  totalAnnualFeePaise: number;
  totalPaidYtdPaise: number;
  concessionGivenPaise: number;
  balanceRemainingPaise: number;
  contact: string;
  feePaymentId?: number;
}

export async function notifyFeePaymentReceived(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: FeeReceiptParams
): Promise<void> {
  try {
    if (!(env as any).WHATSAPP_ACCESS_TOKEN) return;

    const schoolDb = await getSchoolDB(env, schoolCode);
    const commonDb = getCommonDB(env);

    const superSchool = await commonDb
      .select({ name: superSchoolsSchema.name })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();
    const schoolName = superSchool?.name ?? schoolCode;

    const parents = await getParentsForEnrollment(schoolDb, params.enrollmentId);
    if (!parents.length) return;

    const fmt = (paise: number) => (paise / 100).toLocaleString("en-IN");

    for (const parent of parents) {
      sendFeeReceipt(env, schoolCode, {
        parentUserId: parent.id,
        parentName: parent.name || "Parent",
        parentPhone: parent.phone,
        studentName: params.studentName,
        classSection: params.classSection,
        academicYear: params.academicYear,
        receiptNumber: params.receiptNumber,
        paymentDate: params.paymentDateDisplay,
        paymentMode: params.paymentMode,
        feesPaidBreakdown: params.feesPaidBreakdown,
        amountPaid: fmt(params.amountPaidPaise),
        totalAnnualFee: fmt(params.totalAnnualFeePaise),
        totalPaidYtd: fmt(params.totalPaidYtdPaise),
        concessionGiven: fmt(params.concessionGivenPaise),
        balanceRemaining: fmt(params.balanceRemainingPaise),
        schoolName,
        contact: params.contact,
        feePaymentId: params.feePaymentId,
      }).catch((err) =>
        console.error(
          `[WA] Fee receipt failed for parent ${parent.id}:`,
          err.message
        )
      );
    }
  } catch (err: any) {
    console.error("[WA] notifyFeePaymentReceived error:", err.message);
  }
}