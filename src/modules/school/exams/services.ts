import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { schoolsSchema } from "../../../db";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolClassSectionSubjectsSchema,
  schoolExamMarksSchema,
  schoolExamsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolSubjectsSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { schoolCardTemplatesSchema } from "../../../db/schemas/school/school-card-templates";
import { schoolExamSubjectsSchema } from "../../../db/schemas/school/school-exam-subjects";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import {
  DEFAULT_ADMIT_TEMPLATE_KEY,
  DEFAULT_REPORT_TEMPLATE_KEY,
  getAdmitTemplate,
  getReportTemplate,
  getTemplatesMeta,
} from "./card-templates";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Compute letter grade from percentage */
function computeGradeLabel(percentage: number): string {
  if (percentage >= 90) return "A+";
  if (percentage >= 80) return "A";
  if (percentage >= 70) return "B+";
  if (percentage >= 60) return "B";
  if (percentage >= 50) return "C";
  if (percentage >= 40) return "D";
  return "F";
}

/**
 * Simple {{placeholder}} renderer.
 * Handles {{#if key}}...{{/if}} for optional logo blocks.
 */
function renderTemplate(
  templateHtml: string,
  data: Record<string, any>
): string {
  let html = templateHtml;

  // Handle {{#if key}}...{{/if}} blocks
  html = html.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key, inner) => {
      return data[key] ? inner : "";
    }
  );

  // Replace {{schoolInitial}} shorthand
  if (data.schoolName && !data.schoolInitial) {
    data.schoolInitial = (data.schoolName as string).charAt(0).toUpperCase();
  }

  // Replace all {{key}} placeholders
  Object.entries(data).forEach(([key, value]) => {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    html = html.replace(regex, String(value ?? ""));
  });

  return html;
}

/** Build a styled timetable HTML table for admit cards */
/**
 * Build timetable HTML — uses subjectLabel when available,
 * falls back to the canonical subjectName from the subjects table.
 */
function buildTimetableHtml(timetableArray: any[]): string {
  if (!timetableArray.length)
    return "<p style='color:#94a3b8;font-size:13px;'>No timetable available.</p>";

  return `
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th>Date</th>
          <th>Time</th>
          <th>Room</th>
          <th>Max Marks</th>
        </tr>
      </thead>
      <tbody>
        ${timetableArray
          .map(
            (t: any) => `
          <tr>
            <td><strong>${
              t.subjectLabel || t.subject || t.subjectName || "—"
            }</strong></td>
            <td>${
              t.date
                ? new Date(t.date).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "—"
            }</td>
            <td>${
              t.startTime
                ? `${t.startTime}${t.endTime ? " – " + t.endTime : ""}`
                : "—"
            }</td>
            <td>${t.room ?? t.roomNumber ?? "—"}</td>
            <td style="text-align:center;">${t.maxMarks ?? "—"}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

/** Build a styled marks table HTML for report cards */
function buildMarksHtml(marksData: any[]): string {
  if (!marksData.length)
    return "<p style='color:#94a3b8;font-size:13px;'>No marks available.</p>";
  const totalObtained = marksData.reduce(
    (s, m) => s + (m.marksObtained ?? 0),
    0
  );
  const totalMax = marksData.reduce((s, m) => s + (m.maxMarks ?? 0), 0);
  const percentage =
    totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : 0;

  return `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Subject</th>
          <th style="text-align:center;">Max Marks</th>
          <th style="text-align:center;">Marks Obtained</th>
          <th style="text-align:center;">Grade</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${marksData
          .map(
            (m: any, i: number) => `
          <tr>
            <td style="text-align:center;color:#94a3b8;">${i + 1}</td>
            <td><strong>${m.subjectName ?? "—"}</strong></td>
            <td style="text-align:center;">${m.maxMarks ?? "—"}</td>
            <td style="text-align:center;font-weight:700;">${
              m.marksObtained ?? "—"
            }</td>
            <td style="text-align:center;">${m.grade ?? "—"}</td>
            <td style="color:#64748b;font-size:12px;">${m.remarks ?? "—"}</td>
          </tr>`
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr style="font-weight:800;background:#f1f5f9;">
          <td colspan="2" style="font-weight:700;">Total</td>
          <td style="text-align:center;font-weight:800;">${totalMax}</td>
          <td style="text-align:center;font-weight:800;">${totalObtained}</td>
          <td colspan="2" style="font-weight:800;">${percentage}%</td>
        </tr>
      </tfoot>
    </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMETABLE JSON builder (shared SELECT fragment)
// Includes subjectLabel so every caller gets it for free.
// ─────────────────────────────────────────────────────────────────────────────

const TIMETABLE_JSON = sql`json_group_array(
  json_object(
    'id',           ${schoolExamSubjectsSchema.id},
    'classSubjectId',${schoolExamSubjectsSchema.classSubjectId},
    'subjectName',  ${schoolSubjectsSchema.name},
    'subjectLabel', ${schoolExamSubjectsSchema.subjectLabel},
    'date',         ${schoolExamSubjectsSchema.date},
    'startTime',    ${schoolExamSubjectsSchema.startTime},
    'endTime',      ${schoolExamSubjectsSchema.endTime},
    'roomNumber',   ${schoolExamSubjectsSchema.roomNumber},
    'maxMarks',     ${schoolExamSubjectsSchema.maxMarks},
    'passingMarks', ${schoolExamSubjectsSchema.passingMarks}
  )
)`;

function parseTimetable(raw: unknown): any[] {
  try {
    return JSON.parse(raw as string);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAM CRUD
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Create Exam Event + Timetable in ONE transaction
 * (exactly what you asked for — per class-section)
 */
export async function createExam(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const [exam] = await tx
      .insert(schoolExamsSchema)
      .values({
        academicYearId: data.academicYearId,
        classSectionId: data.classSectionId,
        name: data.name,
        type: data.type,
        description: data.description,
        // status defaults to "SCHEDULED" in the schema
        // admitCardPublished / reportCardPublished default to false
      })
      .returning();

    const timetableValues = data.subjects.map((s: any) => ({
      examId: exam.id,
      classSubjectId: s.classSubjectId,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      roomNumber: s.roomNumber,
      maxMarks: s.maxMarks,
      passingMarks: s.passingMarks,
      subjectLabel: s.subjectLabel?.trim() || null, // ← NEW
    }));

    await tx.insert(schoolExamSubjectsSchema).values(timetableValues);

    return { exam, message: "Exam event + timetable created successfully" };
  });
}

/**
 * Get All Exams with Full Timetable + Class/Section Names
 * Returns perfect JSON for your UI (including timetable as array)
 */
export async function getExams(env: SchoolEnv["Bindings"], schoolCode: string) {
  const db = await getSchoolDB(env, schoolCode);
  const examColumns = getTableColumns(schoolExamsSchema);

  const rows = await db
    .select({
      ...examColumns,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      timetable: TIMETABLE_JSON.as("timetable"),
    })
    .from(schoolExamsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolExamsSchema.classSectionId, schoolClassSectionsSchema.id)
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
      schoolExamSubjectsSchema,
      eq(schoolExamSubjectsSchema.examId, schoolExamsSchema.id)
    )
    .leftJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .leftJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .groupBy(schoolExamsSchema.id)
    .orderBy(schoolExamsSchema.name);

  return rows.map((e) => ({ ...e, timetable: parseTimetable(e.timetable) }));
}

export async function getExamById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);
  const examColumns = getTableColumns(schoolExamsSchema);

  const rows = await db
    .select({
      ...examColumns,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      timetable: TIMETABLE_JSON.as("timetable"),
    })
    .from(schoolExamsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolExamsSchema.classSectionId, schoolClassSectionsSchema.id)
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
      schoolExamSubjectsSchema,
      eq(schoolExamSubjectsSchema.examId, schoolExamsSchema.id)
    )
    .leftJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .leftJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(eq(schoolExamsSchema.id, id))
    .groupBy(schoolExamsSchema.id);

  if (!rows[0]) throw new Error("Exam not found");
  return { ...rows[0], timetable: parseTimetable(rows[0].timetable) };
}

// ==================== Update Exam ====================
export async function updateExam(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // Update the exam header fields (never let callers touch status / published flags here)
    const { subjects, ...examFields } = data;
    const [updated] = await tx
      .update(schoolExamsSchema)
      .set({ ...examFields, updatedAt: new Date().toISOString() })
      .where(eq(schoolExamsSchema.id, id))
      .returning();

    if (!updated) throw new Error("Exam not found");

    // Replace timetable rows when subjects array is provided
    if (subjects && subjects.length > 0) {
      await tx
        .delete(schoolExamSubjectsSchema)
        .where(eq(schoolExamSubjectsSchema.examId, id));
      const timetableValues = subjects.map((s: any) => ({
        examId: id,
        classSubjectId: s.classSubjectId,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        roomNumber: s.roomNumber,
        maxMarks: s.maxMarks,
        passingMarks: s.passingMarks,
        subjectLabel: s.subjectLabel?.trim() || null, // ← NEW
      }));
      await tx.insert(schoolExamSubjectsSchema).values(timetableValues);
    }

    return { exam: updated, message: "Exam updated successfully" };
  });
}

// ==================== Delete Exam ====================
export async function deleteExam(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const used = await db
    .select()
    .from(schoolExamMarksSchema)
    .where(eq(schoolExamMarksSchema.examId, id))
    .limit(1)
    .get();

  if (used) throw new Error("Cannot delete exam with marks entered");

  const [deleted] = await db
    .delete(schoolExamsSchema)
    .where(eq(schoolExamsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Exam not found");
  return { message: "Exam deleted successfully" };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: EXAM STATUS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manually update the lifecycle status of an exam.
 * SCHEDULED → ACTIVE → COMPLETED (though any transition is allowed by staff).
 */
export async function updateExamStatus(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  status: "SCHEDULED" | "ACTIVE" | "COMPLETED"
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolExamsSchema)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(schoolExamsSchema.id, examId))
    .returning({ id: schoolExamsSchema.id, status: schoolExamsSchema.status });

  if (!updated) throw new Error("Exam not found");

  return { message: `Exam status updated to ${status}`, exam: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: CARD PUBLICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toggle admitCardPublished or reportCardPublished for an exam.
 * Records the timestamp when first published.
 */
export async function publishExamCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  data: { cardType: "ADMIT_CARD" | "REPORT_CARD"; published: boolean }
) {
  const db = await getSchoolDB(env, schoolCode);

  const now = new Date().toISOString();
  const isAdmit = data.cardType === "ADMIT_CARD";

  // Build the update patch — only stamp the published_at when turning ON
  const patch: Record<string, any> = {
    updatedAt: now,
  };

  if (isAdmit) {
    patch.admitCardPublished = data.published;
    if (data.published) patch.admitCardPublishedAt = now;
  } else {
    patch.reportCardPublished = data.published;
    if (data.published) patch.reportCardPublishedAt = now;
  }

  const [updated] = await db
    .update(schoolExamsSchema)
    .set(patch)
    .where(eq(schoolExamsSchema.id, examId))
    .returning({
      id: schoolExamsSchema.id,
      admitCardPublished: schoolExamsSchema.admitCardPublished,
      reportCardPublished: schoolExamsSchema.reportCardPublished,
    });

  if (!updated) throw new Error("Exam not found");

  const cardLabel = isAdmit ? "Admit card" : "Report card";
  const action = data.published ? "published" : "unpublished";
  return { message: `${cardLabel} ${action} successfully`, exam: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKS
// ─────────────────────────────────────────────────────────────────────────────

// Enter Marks (Bulk Grid – teacher picks Exam + Subject)
export async function enterMarks(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any,
  enteredBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    let entered = 0;
    for (const mark of data.marks) {
      // Check if a record already exists for this enrollment + exam + subject
      const existing = await tx
        .select({ id: schoolExamMarksSchema.id })
        .from(schoolExamMarksSchema)
        .where(
          and(
            eq(schoolExamMarksSchema.examId, data.examId),
            eq(schoolExamMarksSchema.classSubjectId, data.classSubjectId),
            eq(schoolExamMarksSchema.enrollmentId, mark.enrollmentId)
          )
        )
        .get();

      if (existing) {
        // UPDATE existing record
        await tx
          .update(schoolExamMarksSchema)
          .set({
            marksObtained: mark.marksObtained,
            grade: mark.grade ?? "",
            remarks: mark.remarks ?? "",
            enteredBy,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schoolExamMarksSchema.id, existing.id));
      } else {
        // INSERT new record
        await tx.insert(schoolExamMarksSchema).values({
          examId: data.examId,
          classSubjectId: data.classSubjectId,
          enrollmentId: mark.enrollmentId,
          marksObtained: mark.marksObtained,
          grade: mark.grade ?? "",
          remarks: mark.remarks ?? "",
          enteredBy,
        });
      }
      entered++;
    }
    return { message: `Marks saved for ${entered} students`, updated: entered };
  });
}

// ==================== Get Marks by Student ====================
export async function getMarksByStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  examId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId))
    .get();

  if (!enrollment) return [];

  const conditions = [eq(schoolExamMarksSchema.enrollmentId, enrollment.id)];
  if (examId) conditions.push(eq(schoolExamMarksSchema.examId, examId));

  return await db
    .select({
      ...getTableColumns(schoolExamMarksSchema),
      subjectName: schoolSubjectsSchema.name,
      subjectLabel: schoolExamSubjectsSchema.subjectLabel, // ← NEW
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamSubjectsSchema,
      and(
        eq(schoolExamMarksSchema.examId, schoolExamSubjectsSchema.examId),
        eq(
          schoolExamMarksSchema.classSubjectId,
          schoolExamSubjectsSchema.classSubjectId
        )
      )
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(and(...conditions));
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT PORTAL
// ─────────────────────────────────────────────────────────────────────────────

// ==================== STUDENT: Get own exams (from enrollment) ====================
export async function getStudentExams(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
    })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) return { exams: [], enrollment: null };

  const examColumns = getTableColumns(schoolExamsSchema);

  const exams = await db
    .select({
      ...examColumns,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      timetable: TIMETABLE_JSON.as("timetable"),
    })
    .from(schoolExamsSchema)
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolExamsSchema.classSectionId, schoolClassSectionsSchema.id)
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
      schoolExamSubjectsSchema,
      eq(schoolExamSubjectsSchema.examId, schoolExamsSchema.id)
    )
    .leftJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .leftJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(eq(schoolExamsSchema.classSectionId, enrollment.classSectionId))
    .groupBy(schoolExamsSchema.id)
    .orderBy(schoolExamsSchema.name);

  const parsedExams = exams.map((e) => ({
    ...e,
    timetable: parseTimetable(e.timetable),
  }));
  return { exams: parsedExams, enrollment };
}

export async function getStudentOwnMarks(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  examId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) return { marks: [] };

  const conditions = [eq(schoolExamMarksSchema.enrollmentId, enrollment.id)];
  if (examId) conditions.push(eq(schoolExamMarksSchema.examId, examId));

  const marks = await db
    .select({
      id: schoolExamMarksSchema.id,
      examId: schoolExamMarksSchema.examId,
      classSubjectId: schoolExamMarksSchema.classSubjectId,
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      remarks: schoolExamMarksSchema.remarks,
      subjectName: schoolSubjectsSchema.name,
      subjectLabel: schoolExamSubjectsSchema.subjectLabel, // ← NEW
      maxMarks: schoolExamSubjectsSchema.maxMarks,
      passingMarks: schoolExamSubjectsSchema.passingMarks,
      examName: schoolExamsSchema.name,
      examType: schoolExamsSchema.type,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamSubjectsSchema,
      and(
        eq(schoolExamMarksSchema.examId, schoolExamSubjectsSchema.examId),
        eq(
          schoolExamMarksSchema.classSubjectId,
          schoolExamSubjectsSchema.classSubjectId
        )
      )
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(
      schoolExamsSchema,
      eq(schoolExamMarksSchema.examId, schoolExamsSchema.id)
    )
    .where(and(...conditions));

  return { marks };
}

// Get Admit Card Data (frontend prints with Tailwind)
/* ====================== ADMIT CARD (with template) ====================== */
/**
 * Returns FULL ready-to-print HTML using the school's active Admit Card template
 * + all student/exam/timetable data injected via {{placeholders}}
 */
// ─────────────────────────────────────────────────────────────────────────────
// ADMIT CARD  (staff — no publication gate)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAdmitCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const rawData = await db
    .select({
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      examName: schoolExamsSchema.name,
      schoolName: schoolsSchema.name,
      schoolLogo: schoolsSchema.logoUrl,
      academicYearName: schoolAcademicYearsSchema.name,
      timetable: sql`json_group_array(
        json_object(
          'subject',      ${schoolSubjectsSchema.name},
          'subjectLabel', ${schoolExamSubjectsSchema.subjectLabel},
          'date',         ${schoolExamSubjectsSchema.date},
          'startTime',    ${schoolExamSubjectsSchema.startTime},
          'endTime',      ${schoolExamSubjectsSchema.endTime},
          'room',         ${schoolExamSubjectsSchema.roomNumber},
          'maxMarks',     ${schoolExamSubjectsSchema.maxMarks}
        )
      )`.as("timetable"),
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
      schoolExamsSchema,
      eq(schoolExamsSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(schoolExamsSchema.academicYearId, schoolAcademicYearsSchema.id)
    )
    .innerJoin(
      schoolExamSubjectsSchema,
      eq(schoolExamSubjectsSchema.examId, schoolExamsSchema.id)
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(schoolsSchema, eq(schoolsSchema.id, schoolExamsSchema.schoolId))
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolExamsSchema.id, examId)
      )
    )
    .groupBy(schoolExamsSchema.id)
    .get();

  if (!rawData)
    throw new Error(
      "Admit card data not found. Ensure the student is enrolled in the exam's class-section."
    );

  const templateRecord = await getActiveTemplateRecord(db, "ADMIT_CARD");
  const templateKey = templateRecord?.templateKey ?? DEFAULT_ADMIT_TEMPLATE_KEY;
  const template = getAdmitTemplate(templateKey);

  const timetableArray = parseTimetable(rawData.timetable);
  const timetableHtml = buildTimetableHtml(timetableArray);

  const finalHtml = renderTemplate(template.htmlContent, {
    studentName: rawData.studentName,
    className: rawData.className,
    sectionName: rawData.sectionName,
    rollNumber: rawData.rollNumber ?? "—",
    examName: rawData.examName,
    schoolName: rawData.schoolName,
    schoolLogo: rawData.schoolLogo ?? "",
    academicYear: rawData.academicYearName,
    timetableTable: timetableHtml,
    currentDate: new Date().toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    currentYear: new Date().getFullYear(),
  });

  return { html: finalHtml, templateKey };
}

// ==================== STUDENT: Get own admit card ====================
export async function getStudentOwnAdmitCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Publication gate ────────────────────────────────────────────────────
  const examMeta = await db
    .select({ admitCardPublished: schoolExamsSchema.admitCardPublished })
    .from(schoolExamsSchema)
    .where(eq(schoolExamsSchema.id, examId))
    .get();

  if (!examMeta) throw new Error("Exam not found");

  if (!examMeta.admitCardPublished) {
    // Throw a sentinel string — routes.ts surfaces this as a structured 403
    throw new Error("ADMIT_CARD_NOT_PUBLISHED");
  }

  // Gate passed — delegate to shared admit-card builder
  return getAdmitCard(env, schoolCode, examId, studentId);
}

// Generate Report Card (per exam – frontend prints)
/* ====================== REPORT CARD (with template) ====================== */
/**
 * Returns FULL ready-to-print HTML using the school's active Report Card template
 * + marks table + percentage (calculated on-the-fly)
 */
export async function generateReportCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const enrollment = await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
    })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment) throw new Error("Student enrollment not found");

  const studentInfo = await db
    .select({
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      examName: schoolExamsSchema.name,
      schoolName: schoolsSchema.name,
      schoolLogo: schoolsSchema.logoUrl,
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
      schoolExamsSchema,
      eq(schoolExamsSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .innerJoin(
      schoolAcademicYearsSchema,
      eq(schoolExamsSchema.academicYearId, schoolAcademicYearsSchema.id)
    )
    .innerJoin(schoolsSchema, eq(schoolsSchema.id, schoolExamsSchema.schoolId))
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolExamsSchema.id, examId)
      )
    )
    .get();

  if (!studentInfo) throw new Error("Report card data not found");

  const marksData = await db
    .select({
      subjectName: schoolSubjectsSchema.name,
      subjectLabel: schoolExamSubjectsSchema.subjectLabel, // ← NEW
      maxMarks: schoolExamSubjectsSchema.maxMarks,
      passingMarks: schoolExamSubjectsSchema.passingMarks,
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      remarks: schoolExamMarksSchema.remarks,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolExamSubjectsSchema,
      and(
        eq(schoolExamMarksSchema.examId, schoolExamSubjectsSchema.examId),
        eq(
          schoolExamMarksSchema.classSubjectId,
          schoolExamSubjectsSchema.classSubjectId
        )
      )
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolExamSubjectsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .where(
      and(
        eq(schoolExamMarksSchema.examId, examId),
        eq(schoolExamMarksSchema.enrollmentId, enrollment.id)
      )
    );

  const totalObtained = marksData.reduce(
    (s, m) => s + (m.marksObtained ?? 0),
    0
  );
  const totalMax = marksData.reduce((s, m) => s + (m.maxMarks ?? 0), 0);
  const percentage =
    totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : 0;
  const gradeLabel = computeGradeLabel(percentage);
  const isPassed =
    marksData.length > 0 &&
    marksData.every(
      (m) =>
        m.marksObtained >= (m.passingMarks ?? Math.floor(m.maxMarks * 0.33))
    );

  const templateRecord = await getActiveTemplateRecord(db, "REPORT_CARD");
  const templateKey =
    templateRecord?.templateKey ?? DEFAULT_REPORT_TEMPLATE_KEY;
  const template = getReportTemplate(templateKey);

  const marksTableHtml = buildMarksHtml(marksData);

  const finalHtml = renderTemplate(template.htmlContent, {
    studentName: studentInfo.studentName,
    className: studentInfo.className,
    sectionName: studentInfo.sectionName,
    rollNumber: studentInfo.rollNumber ?? "—",
    examName: studentInfo.examName,
    schoolName: studentInfo.schoolName,
    schoolLogo: studentInfo.schoolLogo ?? "",
    academicYear: studentInfo.academicYearName,
    percentage,
    totalObtained,
    totalMax,
    gradeLabel,
    passStatus: isPassed ? "PASS" : "FAIL",
    passStatusClass: isPassed ? "pass" : "fail",
    marksTable: marksTableHtml,
    currentDate: new Date().toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    currentYear: new Date().getFullYear(),
  });

  return {
    html: finalHtml,
    templateKey,
    rawData: {
      ...studentInfo,
      marks: marksData,
      percentage,
      totalObtained,
      totalMax,
      gradeLabel,
      isPassed,
    },
  };
}

// ==================== STUDENT: Get own report card ====================
export async function getStudentOwnReportCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);
 
  const examMeta = await db
    .select({ reportCardPublished: schoolExamsSchema.reportCardPublished })
    .from(schoolExamsSchema)
    .where(eq(schoolExamsSchema.id, examId))
    .get();
 
  if (!examMeta) throw new Error("Exam not found");
 
  if (!examMeta.reportCardPublished) {
    throw new Error("REPORT_CARD_NOT_PUBLISHED");
  }
 
  return generateReportCard(env, schoolCode, examId, studentId);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE MANAGEMENT — store only the key, not the full HTML
// ─────────────────────────────────────────────────────────────────────────────

/** Internal helper — reads the active template record from DB */
async function getActiveTemplateRecord(
  db: any,
  type: "ADMIT_CARD" | "REPORT_CARD"
) {
  return db
    .select()
    .from(schoolCardTemplatesSchema)
    .where(
      and(
        eq(schoolCardTemplatesSchema.type, type),
        eq(schoolCardTemplatesSchema.isActive, true)
      )
    )
    .limit(1)
    .get();
}

/**
 * Save the chosen template key for a school.
 * Only stores the key + name; htmlContent in DB is empty string (not used).
 */
export async function saveTemplateSelection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    type: "ADMIT_CARD" | "REPORT_CARD";
    templateKey: string;
    name: string;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  // Deactivate existing
  await db
    .update(schoolCardTemplatesSchema)
    .set({ isActive: false })
    .where(eq(schoolCardTemplatesSchema.type, data.type));

  const [record] = await db
    .insert(schoolCardTemplatesSchema)
    .values({
      type: data.type,
      name: data.name,
      htmlContent: "", // Not used — HTML served from constants
      templateKey: data.templateKey,
      isActive: true,
    } as any)
    .returning();

  return { record, message: `${data.type} template updated` };
}

/** Returns available template metadata (for picker UI) + currently active key */
export async function getTemplateConfig(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  type: "ADMIT_CARD" | "REPORT_CARD"
) {
  const db = await getSchoolDB(env, schoolCode);
  const active = await getActiveTemplateRecord(db, type);

  return {
    activeKey:
      active?.templateKey ??
      (type === "ADMIT_CARD"
        ? DEFAULT_ADMIT_TEMPLATE_KEY
        : DEFAULT_REPORT_TEMPLATE_KEY),
    templates: getTemplatesMeta(type),
  };
}

/* ====================== TEMPLATE HELPER ====================== */
// ─────────────────────────────────────────────────────────────────────────────
// LEGACY — kept for backward compat, now delegates to new system
// ─────────────────────────────────────────────────────────────────────────────

export async function createOrUpdateTemplate(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  // If caller passes templateKey use new system; otherwise keep old behaviour
  if (data.templateKey) {
    return saveTemplateSelection(env, schoolCode, {
      type: data.type,
      templateKey: data.templateKey,
      name: data.name,
    });
  }
  // Legacy: store full HTML (old behaviour)
  const db = await getSchoolDB(env, schoolCode);
  await db
    .update(schoolCardTemplatesSchema)
    .set({ isActive: false })
    .where(eq(schoolCardTemplatesSchema.type, data.type));

  const [template] = await db
    .insert(schoolCardTemplatesSchema)
    .values({
      type: data.type,
      name: data.name,
      htmlContent: data.htmlContent,
      isActive: true,
    })
    .returning();

  return { template, message: `${data.type} template saved` };
}

export async function getActiveTemplate(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  type: "ADMIT_CARD" | "REPORT_CARD"
) {
  const db = await getSchoolDB(env, schoolCode);
  const record = await getActiveTemplateRecord(db, type);
  if (record?.templateKey) {
    const tmpl =
      type === "ADMIT_CARD"
        ? getAdmitTemplate(record.templateKey)
        : getReportTemplate(record.templateKey);
    return { ...record, htmlContent: tmpl.htmlContent };
  }
  return record || { htmlContent: null };
}
