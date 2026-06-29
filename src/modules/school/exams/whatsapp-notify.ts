// src/modules/school/exams/whatsapp-notify.ts
//
// Fire-and-forget WhatsApp notifications for the exams module.
//
// USAGE:
//   import { notifyExamResult, notifyAssignmentDue } from "./whatsapp-notify";
//   notifyExamResult(env, schoolCode, { enrollmentId, ... }).catch(console.error);


import { eq, and } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import { getCommonDB } from "../../../db";
import {
  schoolUsersSchema,
  schoolStudentEnrollmentsSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { schoolsSchema as superSchoolsSchema } from "../../../db/schemas/super";
import { sendExamResult, sendAssignmentReminder } from "../whatsapp/send-service";
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

// ── EXAM RESULT ───────────────────────────────────────────────────────────────

interface ExamResultParams {
  enrollmentId: number;
  studentName: string;
  classSection: string;
  rollNumber: string;
  examName: string;
  academicYear: string;
  resultSummary: string;    // e.g. "English: 72/80 (A) | Maths: 68/80 (B+)"
  marksObtained: number;
  totalMarks: number;
  percentage?: string;      // pre-formatted e.g. "89.06" — computed if omitted
  overallGrade: string;
  resultStatus: string;     // "PASS" | "FAIL"
  portalUrl: string;
  examId?: number;
}

export async function notifyExamResult(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: ExamResultParams
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

    const percentage =
      params.percentage ??
      ((params.marksObtained / params.totalMarks) * 100).toFixed(2);

    for (const parent of parents) {
      sendExamResult(env, schoolCode, {
        parentUserId: parent.id,
        parentName: parent.name || "Parent",
        parentPhone: parent.phone,
        studentName: params.studentName,
        classSection: params.classSection,
        rollNumber: params.rollNumber,
        examName: params.examName,
        academicYear: params.academicYear,
        resultSummary: params.resultSummary,
        totalMarks: String(params.marksObtained),
        totalOutOf: String(params.totalMarks),
        percentage,
        overallGrade: params.overallGrade,
        resultStatus: params.resultStatus,
        portalUrl: params.portalUrl,
        schoolName,
        examId: params.examId,
      }).catch((err) =>
        console.error(
          `[WA] Exam result notify failed for parent ${parent.id}:`,
          err.message
        )
      );
    }
  } catch (err: any) {
    console.error("[WA] notifyExamResult error:", err.message);
  }
}

// ── ASSIGNMENT DUE ────────────────────────────────────────────────────────────

interface AssignmentDueParams {
  enrollmentId: number;
  studentName: string;
  classSection: string;
  subject: string;
  teacherName: string;
  assignmentTitle: string;
  assignmentType: string;   // e.g. "Home Work" | "Class Work" | "Assignment"
  dueDate: string;
  maxMarks: number;
  isMandatory: boolean;
  description: string;
  assignmentId?: number;
}

export async function notifyAssignmentDue(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: AssignmentDueParams
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

    for (const parent of parents) {
      sendAssignmentReminder(env, schoolCode, {
        parentUserId: parent.id,
        parentName: parent.name || "Parent",
        parentPhone: parent.phone,
        studentName: params.studentName,
        classSection: params.classSection,
        subject: params.subject,
        teacherName: params.teacherName,
        assignmentTitle: params.assignmentTitle,
        assignmentType: params.assignmentType,
        dueDate: params.dueDate,
        maxMarks: String(params.maxMarks),
        isMandatory: params.isMandatory ? "Yes" : "No",
        description: params.description,
        schoolName,
        assignmentId: params.assignmentId,
      }).catch((err) =>
        console.error(
          `[WA] Assignment notify failed for parent ${parent.id}:`,
          err.message
        )
      );
    }
  } catch (err: any) {
    console.error("[WA] notifyAssignmentDue error:", err.message);
  }
}