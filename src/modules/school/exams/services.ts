import { getSchoolDB } from "../../../db/school-client";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import {
  schoolExamsSchema,
  schoolExamMarksSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolClassSectionSubjectsSchema,
  schoolSubjectsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import {
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { schoolExamSubjectsSchema } from "../../../db/schemas/school/school-exam-subjects";
import { schoolsSchema } from "../../../db";
import { schoolCardTemplatesSchema } from "../../../db/schemas/school/school-card-templates";

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
      })
      .returning();

    // Insert timetable subjects
    const timetableValues = data.subjects.map((s: any) => ({
      examId: exam.id,
      classSubjectId: s.classSubjectId,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      roomNumber: s.roomNumber,
      maxMarks: s.maxMarks,
      passingMarks: s.passingMarks,
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

  const examColumns = getTableColumns(schoolExamsSchema); // ← THIS FIXES THE ERROR

  return await db
    .select({
      ...examColumns, // ← Fixed
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      timetable: sql`json_group_array(
        json_object(
          'subjectName', ${schoolSubjectsSchema.name},
          'date', ${schoolExamSubjectsSchema.date},
          'startTime', ${schoolExamSubjectsSchema.startTime},
          'endTime', ${schoolExamSubjectsSchema.endTime},
          'roomNumber', ${schoolExamSubjectsSchema.roomNumber},
          'maxMarks', ${schoolExamSubjectsSchema.maxMarks}
        )
      )`.as("timetable"),
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
}

// ==================== Update Exam ====================
export async function updateExam(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolExamsSchema)
    .set(data)
    .where(eq(schoolExamsSchema.id, id))
    .returning();

  if (!updated) throw new Error("Exam not found");

  return { exam: updated, message: "Exam updated successfully" };
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
      await tx.insert(schoolExamMarksSchema).values({
        examId: data.examId,
        classSubjectId: data.classSubjectId,
        enrollmentId: mark.enrollmentId,
        marksObtained: mark.marksObtained,
        grade: mark.grade,
        remarks: mark.remarks,
        enteredBy,
      });
      entered++;
    }
    return { message: `Marks entered for ${entered} students` };
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
  const where = [eq(schoolStudentEnrollmentsSchema.studentId, studentId)];
  if (examId) where.push(eq(schoolExamMarksSchema.examId, examId));

  return await db
    .select({
      ...getTableColumns(schoolExamMarksSchema),
      subjectName: schoolSubjectsSchema.name,
    })
    .from(schoolExamMarksSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(schoolExamMarksSchema.enrollmentId, schoolStudentEnrollmentsSchema.id)
    )
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
    .where(and(...where));
}

// Get Admit Card Data (frontend prints with Tailwind)
/* ====================== ADMIT CARD (with template) ====================== */
/**
 * Returns FULL ready-to-print HTML using the school's active Admit Card template
 * + all student/exam/timetable data injected via {{placeholders}}
 */
export async function getAdmitCard(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Fetch all raw data + school logo in ONE query
  const rawData = await db
    .select({
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      examName: schoolExamsSchema.name,
      schoolName: schoolsSchema.name,
      schoolLogo: schoolsSchema.logoUrl,
      timetable: sql`json_group_array(
        json_object(
          'subject', ${schoolSubjectsSchema.name},
          'date', ${schoolExamSubjectsSchema.date},
          'startTime', ${schoolExamSubjectsSchema.startTime},
          'room', ${schoolExamSubjectsSchema.roomNumber}
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
    .innerJoin(schoolsSchema, eq(schoolsSchema.id, schoolExamsSchema.schoolId)) // logo
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolExamsSchema.id, examId)
      )
    )
    .groupBy(schoolExamsSchema.id);

  if (!rawData[0]) {
    throw new Error("Admit card data not found");
  }

  const data = rawData[0];

  // 2. Get active template
  const template = await getActiveTemplate(env, schoolCode, "ADMIT_CARD");

  // 3. Build beautiful timetable HTML table
  const timetableArray = data.timetable
    ? JSON.parse(data.timetable as string)
    : [];
  const timetableHtml = `
    <table style="width:100%; border-collapse:collapse; margin:20px 0;">
      <thead>
        <tr style="background:#f0f0f0;">
          <th style="border:1px solid #ccc; padding:8px;">Subject</th>
          <th style="border:1px solid #ccc; padding:8px;">Date</th>
          <th style="border:1px solid #ccc; padding:8px;">Time</th>
          <th style="border:1px solid #ccc; padding:8px;">Room</th>
        </tr>
      </thead>
      <tbody>
        ${timetableArray
          .map(
            (t: any) => `
          <tr>
            <td style="border:1px solid #ccc; padding:8px;">${t.subject}</td>
            <td style="border:1px solid #ccc; padding:8px;">${t.date}</td>
            <td style="border:1px solid #ccc; padding:8px;">${
              t.startTime || "—"
            }</td>
            <td style="border:1px solid #ccc; padding:8px;">${
              t.room || "—"
            }</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  // 4. Render template
  const finalHtml = renderTemplate(
    template.htmlContent ||
      `<h1 style="color:red;">No Admit Card template configured yet</h1>`,
    {
      studentName: data.studentName,
      className: data.className,
      sectionName: data.sectionName,
      rollNumber: data.rollNumber,
      examName: data.examName,
      schoolName: data.schoolName,
      schoolLogo: data.schoolLogo || "",
      timetableTable: timetableHtml,
      currentDate: new Date().toLocaleDateString("en-IN"),
      currentYear: new Date().getFullYear(),
    }
  );

  return { html: finalHtml, rawData: data };
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

  // 1. Fetch student info + all marks for this exam
  const studentInfo = await db
    .select({
      studentName: schoolUsersSchema.name,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      examName: schoolExamsSchema.name,
      schoolName: schoolsSchema.name,
      schoolLogo: schoolsSchema.logoUrl,
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
    .innerJoin(schoolsSchema, eq(schoolsSchema.id, schoolExamsSchema.schoolId))
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolExamsSchema.id, examId)
      )
    )
    .get();

  if (!studentInfo) {
    throw new Error("Report card data not found");
  }

  // 2. Fetch marks
  const marksData = await db
    .select({
      subjectName: schoolSubjectsSchema.name,
      maxMarks: schoolExamSubjectsSchema.maxMarks,
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
        eq(
          schoolExamMarksSchema.enrollmentId,
          schoolStudentEnrollmentsSchema.id
        ) // from previous join
      )
    );

  // 3. Calculate totals on-the-fly
  const totalObtained = marksData.reduce(
    (sum, m) => sum + (m.marksObtained || 0),
    0
  );
  const totalMax = marksData.reduce((sum, m) => sum + (m.maxMarks || 0), 0);
  const percentage =
    totalMax > 0 ? Math.round((totalObtained / totalMax) * 100) : 0;

  // 4. Build marks table HTML
  const marksTableHtml = `
    <table style="width:100%; border-collapse:collapse; margin:20px 0;">
      <thead>
        <tr style="background:#f0f0f0;">
          <th style="border:1px solid #ccc; padding:10px;">Subject</th>
          <th style="border:1px solid #ccc; padding:10px;">Max Marks</th>
          <th style="border:1px solid #ccc; padding:10px;">Obtained</th>
          <th style="border:1px solid #ccc; padding:10px;">Grade</th>
          <th style="border:1px solid #ccc; padding:10px;">Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${marksData
          .map(
            (m) => `
          <tr>
            <td style="border:1px solid #ccc; padding:10px;">${
              m.subjectName
            }</td>
            <td style="border:1px solid #ccc; padding:10px;">${m.maxMarks}</td>
            <td style="border:1px solid #ccc; padding:10px;">${
              m.marksObtained
            }</td>
            <td style="border:1px solid #ccc; padding:10px;">${
              m.grade || "—"
            }</td>
            <td style="border:1px solid #ccc; padding:10px;">${
              m.remarks || "—"
            }</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr style="background:#e0e0e0; font-weight:bold;">
          <td style="border:1px solid #ccc; padding:10px;">Total</td>
          <td style="border:1px solid #ccc; padding:10px;">${totalMax}</td>
          <td style="border:1px solid #ccc; padding:10px;">${totalObtained}</td>
          <td colspan="2" style="border:1px solid #ccc; padding:10px;">${percentage}%</td>
        </tr>
      </tfoot>
    </table>
  `;

  // 5. Get active template
  const template = await getActiveTemplate(env, schoolCode, "REPORT_CARD");

  // 6. Render
  const finalHtml = renderTemplate(
    template.htmlContent ||
      `<h1 style="color:red;">No Report Card template configured yet</h1>`,
    {
      studentName: studentInfo.studentName,
      className: studentInfo.className,
      sectionName: studentInfo.sectionName,
      rollNumber: studentInfo.rollNumber,
      examName: studentInfo.examName,
      schoolName: studentInfo.schoolName,
      schoolLogo: studentInfo.schoolLogo || "",
      percentage,
      marksTable: marksTableHtml,
      currentDate: new Date().toLocaleDateString("en-IN"),
      currentYear: new Date().getFullYear(),
    }
  );

  return {
    html: finalHtml,
    rawData: {
      ...studentInfo,
      marks: marksData,
      percentage,
      totalObtained,
      totalMax,
    },
  };
}

/* ====================== TEMPLATE HELPER ====================== */
function renderTemplate(
  templateHtml: string,
  data: Record<string, any>
): string {
  let html = templateHtml;

  // Replace simple placeholders
  Object.entries(data).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, "g");
    html = html.replace(regex, String(value || ""));
  });

  // Special complex parts (tables)
  if (data.timetableTable)
    html = html.replace(/{{timetableTable}}/g, data.timetableTable);
  if (data.marksTable) html = html.replace(/{{marksTable}}/g, data.marksTable);

  return html;
}

/**
 * Create or Update Template (School Owner only)
 * Example payload: { type: "ADMIT_CARD", name: "Official 2026", htmlContent: "<html>...</html>" }
 */
export async function createOrUpdateTemplate(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  // Deactivate old template of same type
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
  const [template] = await db
    .select()
    .from(schoolCardTemplatesSchema)
    .where(
      and(
        eq(schoolCardTemplatesSchema.type, type),
        eq(schoolCardTemplatesSchema.isActive, true)
      )
    )
    .limit(1);

  return template || { htmlContent: null }; // fallback if none exists
}
