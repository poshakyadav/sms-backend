// src/modules/school/attendance/whatsapp-notify.ts

import { eq, and } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import { getCommonDB } from "../../../db";
import {
  schoolUsersSchema,
  studentParentsSchema,
} from "../../../db/schemas/school";
import { schoolsSchema as superSchoolsSchema } from "../../../db/schemas/super";
import { sendAttendanceNotification } from "../whatsapp/send-service";
import { SchoolEnv } from "../../../types/common-types";

interface AttendanceNotifyParams {
  studentId: number;
  studentName: string;
  date: string;
  status: string;
  classSection: string;
  note?: string; // ← NEW: maps to {{7}} in school_student_absent_today
}

export async function notifyAttendanceMarked(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: AttendanceNotifyParams
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

    const parents = await schoolDb
      .select({
        parentId: schoolUsersSchema.id,
        parentName: schoolUsersSchema.name,
        parentPhone: schoolUsersSchema.phone,
      })
      .from(studentParentsSchema)
      .innerJoin(
        schoolUsersSchema,
        eq(studentParentsSchema.parentId, schoolUsersSchema.id)
      )
      .where(
        and(
          eq(studentParentsSchema.studentId, params.studentId),
          eq(schoolUsersSchema.isActive, true)
        )
      )
      .all();

    if (!parents.length) return;

    for (const parent of parents) {
      if (!parent.parentPhone) continue;

      sendAttendanceNotification(env, schoolCode, {
        parentUserId: parent.parentId,
        parentName: parent.parentName || "Parent",
        parentPhone: parent.parentPhone,
        studentName: params.studentName,
        date: params.date,
        classSection: params.classSection,
        status: params.status,
        schoolName,
        note: params.note ?? "No prior intimation received",
      }).catch((err) =>
        console.error(
          `[WA] Attendance notify failed for parent ${parent.parentId}:`,
          err.message
        )
      );
    }
  } catch (err: any) {
    console.error("[WA] notifyAttendanceMarked error:", err.message);
  }
}
