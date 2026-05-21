// src/modules/school/exams/marks-excel.service.ts
//
// ─── EXCEL BULK MARKS IMPORT / EXPORT ────────────────────────────────────────
//
// DESIGN PRINCIPLES
// ─────────────────
//  • Download  → generate an .xlsx template pre-filled with student name,
//                roll number, max marks, and any previously saved marks.
//                Protected cells (everything except "Marks Obtained") so a
//                teacher cannot accidentally corrupt the structure.
//
//  • Upload    → parse the .xlsx, validate every cell, upsert marks in a
//                single DB transaction.  Idempotent — re-uploading the same
//                file is safe; marks are overwritten with the new values.
//
//  • Security  → hidden metadata sheet stores examId + classSubjectId so we
//                never trust user-supplied IDs from the filename alone.
//
// DEPENDENCIES (must be in package.json)
//    exceljs  ^4.4.0   (chosen over xlsx for rich formatting + stream support)
// ─────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import {
  schoolClassSectionSubjectsSchema,
  schoolClassSectionsSchema,
  schoolClassesSchema,
  schoolExamMarksSchema,
  schoolExamSubjectsSchema,
  schoolExamsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolSubjectsSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

// ─── Column layout (1-indexed for ExcelJS) ───────────────────────────────────
const COL = {
  ENROLLMENT_ID: 1, // A  — hidden, used for upsert key
  ROLL_NUMBER: 2, // B
  STUDENT_NAME: 3, // C
  MAX_MARKS: 4, // D
  PASSING_MARKS: 5, // E
  MARKS_OBTAINED: 6, // F  ← only editable column
  GRADE: 7, // G  — reference on download; auto-computed on upload
  REMARKS: 8, // H  — optional teacher comment (editable)
} as const;

const DATA_START_ROW = 6; // Rows 1-5 are the header block

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds and returns an ExcelJS Workbook buffer ready to stream to the client.
 *
 * The workbook contains two sheets:
 *   1. "Marks Entry"  — the sheet the teacher fills in
 *   2. "_meta"        — hidden sheet with examId, classSubjectId for validation
 */
export async function generateMarksTemplate(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  classSubjectId: number,
  enteredBy: number
): Promise<{ buffer: Buffer; filename: string }> {
  const db = await getSchoolDB(env, schoolCode);

  // ── 1. Load exam + subject metadata ────────────────────────────────────────
  const examSubject = await db
    .select({
      examName: schoolExamsSchema.name,
      examType: schoolExamsSchema.type,
      subjectName: schoolSubjectsSchema.name,
      subjectLabel: schoolExamSubjectsSchema.subjectLabel,
      maxMarks: schoolExamSubjectsSchema.maxMarks,
      passingMarks: schoolExamSubjectsSchema.passingMarks,
      examDate: schoolExamSubjectsSchema.date,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolExamSubjectsSchema)
    .innerJoin(
      schoolExamsSchema,
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
    .where(
      and(
        eq(schoolExamSubjectsSchema.examId, examId),
        eq(schoolExamSubjectsSchema.classSubjectId, classSubjectId)
      )
    )
    .get();

  if (!examSubject) {
    throw new Error(
      "Exam subject not found. Verify examId and classSubjectId."
    );
  }

  // ── 2. Load enrolled students with any existing marks ──────────────────────
  const students = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      // existing marks (null if not yet entered)
      marksObtained: schoolExamMarksSchema.marksObtained,
      grade: schoolExamMarksSchema.grade,
      remarks: schoolExamMarksSchema.remarks,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .leftJoin(
      schoolExamMarksSchema,
      and(
        eq(
          schoolExamMarksSchema.enrollmentId,
          schoolStudentEnrollmentsSchema.id
        ),
        eq(schoolExamMarksSchema.examId, examId),
        eq(schoolExamMarksSchema.classSubjectId, classSubjectId)
      )
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.isActive, true),
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          db
            .select({ id: schoolExamsSchema.classSectionId })
            .from(schoolExamsSchema)
            .where(eq(schoolExamsSchema.id, examId))
            .limit(1) as any
        )
      )
    )
    .orderBy(schoolStudentEnrollmentsSchema.rollNumber, schoolUsersSchema.name)
    .all();

  if (students.length === 0) {
    throw new Error(
      "No active students found in this class-section. Ensure students are enrolled."
    );
  }

  // ── 3. Build workbook ──────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "School Management System";
  wb.created = new Date();

  // ── SHEET 1: Marks Entry ───────────────────────────────────────────────────
  const ws = wb.addWorksheet("Marks Entry", {
    views: [{ state: "frozen", ySplit: DATA_START_ROW - 1 }],
    pageSetup: {
      paperSize: 9, // A4
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
    },
  });

  // Column widths
  ws.getColumn(COL.ENROLLMENT_ID).width = 14;
  ws.getColumn(COL.ROLL_NUMBER).width = 14;
  ws.getColumn(COL.STUDENT_NAME).width = 32;
  ws.getColumn(COL.MAX_MARKS).width = 14;
  ws.getColumn(COL.PASSING_MARKS).width = 16;
  ws.getColumn(COL.MARKS_OBTAINED).width = 18;
  ws.getColumn(COL.GRADE).width = 10;
  ws.getColumn(COL.REMARKS).width = 30;

  // ── Colour palette ─────────────────────────────────────────────────────────
  const BRAND_DARK = "1E3A5F";
  const BRAND_LIGHT = "D6E4F7";
  const INPUT_BG = "FFFDE7"; // pale yellow — editable cells
  const LOCKED_BG = "F5F5F5"; // grey — read-only cells
  const WHITE = "FFFFFF";
  const ERROR_RED = "C62828";
  const SUCCESS_GREEN = "1B5E20";

  // ── Row 1: System title ────────────────────────────────────────────────────
  ws.mergeCells("A1:H1");
  const titleCell = ws.getCell("A1");
  titleCell.value = "School Management System — Marks Entry Template";
  titleCell.font = {
    name: "Arial",
    bold: true,
    size: 14,
    color: { argb: WHITE },
  };
  titleCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_DARK },
  };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 28;

  // ── Row 2: Exam name + type ────────────────────────────────────────────────
  ws.mergeCells("A2:H2");
  const examCell = ws.getCell("A2");
  examCell.value = `${examSubject.examName} (${examSubject.examType})`;
  examCell.font = {
    name: "Arial",
    bold: true,
    size: 12,
    color: { argb: BRAND_DARK },
  };
  examCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_LIGHT },
  };
  examCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(2).height = 22;

  // ── Row 3: Subject + Class ─────────────────────────────────────────────────
  ws.mergeCells("A3:D3");
  const subCell = ws.getCell("A3");
  const subjectDisplay = examSubject.subjectLabel || examSubject.subjectName;
  subCell.value = `Subject: ${subjectDisplay}`;
  subCell.font = { name: "Arial", size: 11, color: { argb: BRAND_DARK } };
  subCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_LIGHT },
  };
  subCell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };

  ws.mergeCells("E3:H3");
  const classCell = ws.getCell("E3");
  classCell.value = `Class: ${examSubject.className} – ${examSubject.sectionName}`;
  classCell.font = { name: "Arial", size: 11, color: { argb: BRAND_DARK } };
  classCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: BRAND_LIGHT },
  };
  classCell.alignment = {
    horizontal: "right",
    vertical: "middle",
    indent: 1,
  };
  ws.getRow(3).height = 20;

  // ── Row 4: Max marks + instruction ────────────────────────────────────────
  ws.mergeCells("A4:D4");
  const marksInfoCell = ws.getCell("A4");
  marksInfoCell.value = `Max Marks: ${examSubject.maxMarks}  |  Passing: ${
    examSubject.passingMarks ?? "N/A"
  }  |  Date: ${examSubject.examDate ?? "TBD"}`;
  marksInfoCell.font = {
    name: "Arial",
    size: 10,
    color: { argb: "555555" },
  };
  marksInfoCell.alignment = {
    horizontal: "left",
    vertical: "middle",
    indent: 1,
  };

  ws.mergeCells("E4:H4");
  const instrCell = ws.getCell("E4");
  instrCell.value =
    "⚠ Only edit the 'Marks Obtained' and 'Remarks' columns. Do NOT modify other columns.";
  instrCell.font = {
    name: "Arial",
    size: 9,
    bold: true,
    color: { argb: ERROR_RED },
  };
  instrCell.alignment = {
    horizontal: "right",
    vertical: "middle",
    indent: 1,
  };
  ws.getRow(4).height = 18;

  // ── Row 5: Column headers ──────────────────────────────────────────────────
  const headerRow = ws.getRow(5);
  const headers = [
    "Enrollment ID",
    "Roll No.",
    "Student Name",
    "Max Marks",
    "Passing Marks",
    "Marks Obtained ✏",
    "Grade",
    "Remarks (optional) ✏",
  ];
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = {
      name: "Arial",
      bold: true,
      size: 10,
      color: { argb: WHITE },
    };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb:
          i === COL.MARKS_OBTAINED - 1 || i === COL.REMARKS - 1
            ? "1565C0" // darker blue for editable columns
            : BRAND_DARK,
      },
    };
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = {
      bottom: { style: "medium", color: { argb: WHITE } },
    };
  });
  headerRow.height = 30;

  // ── Rows 6+: Student data ──────────────────────────────────────────────────
  students.forEach((student, idx) => {
    const rowNum = DATA_START_ROW + idx;
    const row = ws.getRow(rowNum);
    row.height = 20;

    const isAlternate = idx % 2 === 1;
    const lockedBg = isAlternate ? "EEEEEE" : LOCKED_BG;

    // A — Enrollment ID (hidden column, required for upload matching)
    const enrollCell = row.getCell(COL.ENROLLMENT_ID);
    enrollCell.value = student.enrollmentId;
    enrollCell.font = {
      name: "Arial",
      size: 9,
      color: { argb: "999999" },
    };
    enrollCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    enrollCell.alignment = { horizontal: "center" };

    // B — Roll number
    const rollCell = row.getCell(COL.ROLL_NUMBER);
    rollCell.value = student.rollNumber ?? "";
    rollCell.font = { name: "Arial", size: 10 };
    rollCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    rollCell.alignment = { horizontal: "center" };

    // C — Student name
    const nameCell = row.getCell(COL.STUDENT_NAME);
    nameCell.value = student.studentName;
    nameCell.font = { name: "Arial", size: 10, bold: true };
    nameCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    nameCell.alignment = { horizontal: "left", indent: 1 };

    // D — Max marks
    const maxCell = row.getCell(COL.MAX_MARKS);
    maxCell.value = examSubject.maxMarks;
    maxCell.font = { name: "Arial", size: 10 };
    maxCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    maxCell.alignment = { horizontal: "center" };

    // E — Passing marks
    const passCell = row.getCell(COL.PASSING_MARKS);
    passCell.value = examSubject.passingMarks ?? null;
    passCell.font = { name: "Arial", size: 10 };
    passCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    passCell.alignment = { horizontal: "center" };

    // F — Marks obtained (EDITABLE — pre-filled if already saved)
    const obtainedCell = row.getCell(COL.MARKS_OBTAINED);
    obtainedCell.value =
      student.marksObtained !== null && student.marksObtained !== undefined
        ? student.marksObtained
        : null;
    obtainedCell.font = {
      name: "Arial",
      size: 11,
      bold: true,
      color: { argb: "0D47A1" },
    };
    obtainedCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: INPUT_BG },
    };
    obtainedCell.alignment = { horizontal: "center" };

    // ── FIX 1: use `formulae` (array) instead of formula1/formula2 ──────────
    // ExcelJS DataValidation uses `formulae: [min, max]` for "between".
    // Numeric values are passed directly (not as strings) for whole/decimal types.
    obtainedCell.dataValidation = {
      type: "whole",
      operator: "between",
      // formulae is an array: [min, max] — numbers for numeric types
      formulae: [0, examSubject.maxMarks],
      showErrorMessage: true,
      errorTitle: "Invalid Marks",
      error: `Enter a whole number between 0 and ${examSubject.maxMarks}.`,
      showInputMessage: true,
      promptTitle: "Marks Obtained",
      prompt: `Enter marks between 0 and ${examSubject.maxMarks}.`,
    };

    // G — Grade (reference only — computed on upload, shown here if available)
    const gradeCell = row.getCell(COL.GRADE);
    gradeCell.value = student.grade ?? "";
    gradeCell.font = {
      name: "Arial",
      size: 10,
      color: { argb: "555555" },
    };
    gradeCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: lockedBg },
    };
    gradeCell.alignment = { horizontal: "center" };

    // H — Remarks (EDITABLE)
    const remarksCell = row.getCell(COL.REMARKS);
    remarksCell.value = student.remarks ?? "";
    remarksCell.font = {
      name: "Arial",
      size: 10,
      color: { argb: "333333" },
    };
    remarksCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: INPUT_BG },
    };
    remarksCell.alignment = { horizontal: "left", indent: 1 };

    // Thin border on all cells in this row
    for (let c = 1; c <= 8; c++) {
      row.getCell(c).border = {
        top: { style: "thin", color: { argb: "DDDDDD" } },
        bottom: { style: "thin", color: { argb: "DDDDDD" } },
        left: { style: "thin", color: { argb: "DDDDDD" } },
        right: { style: "thin", color: { argb: "DDDDDD" } },
      };
    }
  });

  // ── Summary row (below students) ───────────────────────────────────────────
  const summaryRow = DATA_START_ROW + students.length;
  ws.mergeCells(`A${summaryRow}:E${summaryRow}`);
  ws.getCell(`A${summaryRow}`).value = `Total Students: ${students.length}`;
  ws.getCell(`A${summaryRow}`).font = {
    name: "Arial",
    bold: true,
    size: 10,
    color: { argb: BRAND_DARK },
  };
  ws.getCell(`A${summaryRow}`).alignment = {
    horizontal: "right",
    indent: 1,
  };

  ws.getCell(`F${summaryRow}`).value = {
    formula: `=COUNTA(F${DATA_START_ROW}:F${summaryRow - 1})`,
  } as any;
  ws.getCell(`F${summaryRow}`).font = {
    name: "Arial",
    bold: true,
    size: 10,
    color: { argb: SUCCESS_GREEN },
  };
  ws.getCell(`F${summaryRow}`).alignment = { horizontal: "center" };

  ws.mergeCells(`G${summaryRow}:H${summaryRow}`);
  ws.getCell(`G${summaryRow}`).value = "Entries Filled ↑";
  ws.getCell(`G${summaryRow}`).font = {
    name: "Arial",
    size: 9,
    color: { argb: SUCCESS_GREEN },
  };

  // ── Sheet protection (only F and H columns editable) ──────────────────────
  ws.protect("SMS_MARKS_TEMPLATE_2024", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
  });

  // Unlock only Marks Obtained (F) and Remarks (H) in data rows
  for (
    let rowNum = DATA_START_ROW;
    rowNum < DATA_START_ROW + students.length;
    rowNum++
  ) {
    ws.getRow(rowNum).getCell(COL.MARKS_OBTAINED).protection = {
      locked: false,
    };
    ws.getRow(rowNum).getCell(COL.REMARKS).protection = { locked: false };
  }

  // Hide Enrollment ID column (teachers don't need to see it)
  ws.getColumn(COL.ENROLLMENT_ID).hidden = true;

  // ── SHEET 2: _meta (hidden — carries IDs for server-side validation) ───────
  const metaWs = wb.addWorksheet("_meta");
  metaWs.state = "veryHidden"; // Cannot be unhidden via UI
  metaWs.getCell("A1").value = "examId";
  metaWs.getCell("B1").value = examId;
  metaWs.getCell("A2").value = "classSubjectId";
  metaWs.getCell("B2").value = classSubjectId;
  metaWs.getCell("A3").value = "schoolCode";
  metaWs.getCell("B3").value = schoolCode;
  metaWs.getCell("A4").value = "maxMarks";
  metaWs.getCell("B4").value = examSubject.maxMarks;
  metaWs.getCell("A5").value = "generatedAt";
  metaWs.getCell("B5").value = new Date().toISOString();

  // ── Generate filename ──────────────────────────────────────────────────────
  const safeExam = examSubject.examName.replace(/[^a-zA-Z0-9]/g, "_");
  const safeSubject = subjectDisplay.replace(/[^a-zA-Z0-9]/g, "_");
  const safeClass =
    `${examSubject.className}_${examSubject.sectionName}`.replace(
      /[^a-zA-Z0-9]/g,
      "_"
    );
  const filename = `Marks_${safeExam}_${safeSubject}_${safeClass}.xlsx`;

  // ── FIX 2: writeBuffer() return type cast ──────────────────────────────────
  // wb.xlsx.writeBuffer() resolves to ExcelJS.Buffer (Buffer | ArrayBuffer).
  // At runtime on Node.js it is always a Buffer, but the ExcelJS type definition
  // doesn't overlap perfectly with Node's generic Buffer<ArrayBufferLike>.
  // Cast through `unknown` to satisfy TypeScript without changing runtime behaviour.
  const rawBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(rawBuffer as unknown as ArrayBuffer);

  return { buffer, filename };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE + VALIDATE UPLOADED TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

export interface MarksRow {
  enrollmentId: number;
  marksObtained: number;
  remarks: string;
}

export interface ParseResult {
  success: true;
  examId: number;
  classSubjectId: number;
  rows: MarksRow[];
  warnings: string[];
}

export interface ParseError {
  success: false;
  errors: string[];
}

/**
 * Reads the uploaded .xlsx buffer and returns structured data for DB upsert.
 * Never trusts the file on its own — validates against DB values.
 */
export async function parseMarksTemplate(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  fileBuffer: Buffer
): Promise<ParseResult | ParseError> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── 1. Load workbook ───────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  try {
    // ── FIX 3: fileBuffer type mismatch ────────────────────────────────────
    // Node ≥ 22 introduced Buffer<ArrayBufferLike> as a generic type. ExcelJS's
    // .load() signature expects the older non-generic Buffer. The runtime value
    // is identical — cast through `unknown` to satisfy TS without any change
    // in runtime behaviour.
    await wb.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);
  } catch {
    return {
      success: false,
      errors: [
        "Invalid file. Upload only .xlsx files generated by this system.",
      ],
    };
  }

  // ── 2. Read metadata sheet ─────────────────────────────────────────────────
  const metaWs = wb.getWorksheet("_meta");
  if (!metaWs) {
    return {
      success: false,
      errors: [
        "Unrecognised template. Please download a fresh template from this system and try again.",
      ],
    };
  }

  const examId = Number(metaWs.getCell("B1").value);
  const classSubjectId = Number(metaWs.getCell("B2").value);
  const templateSchoolCode = String(metaWs.getCell("B3").value ?? "");
  const templateMaxMarks = Number(metaWs.getCell("B4").value);

  if (!examId || !classSubjectId) {
    return {
      success: false,
      errors: ["Metadata sheet is corrupted. Download a fresh template."],
    };
  }

  if (templateSchoolCode !== schoolCode) {
    return {
      success: false,
      errors: [
        "This template belongs to a different school. Download a fresh template.",
      ],
    };
  }

  // ── 3. Validate exam + subject still exist in DB ───────────────────────────
  const db = await getSchoolDB(env, schoolCode);
  const examSubjectInDB = await db
    .select({
      maxMarks: schoolExamSubjectsSchema.maxMarks,
      passingMarks: schoolExamSubjectsSchema.passingMarks,
    })
    .from(schoolExamSubjectsSchema)
    .where(
      and(
        eq(schoolExamSubjectsSchema.examId, examId),
        eq(schoolExamSubjectsSchema.classSubjectId, classSubjectId)
      )
    )
    .get();

  if (!examSubjectInDB) {
    return {
      success: false,
      errors: [
        "The exam or subject referenced in this template no longer exists. Download a fresh template.",
      ],
    };
  }

  const maxMarks = examSubjectInDB.maxMarks;

  // Warn if the max marks in the file and DB differ (e.g. exam was edited)
  if (templateMaxMarks !== maxMarks) {
    warnings.push(
      `Max marks in template (${templateMaxMarks}) differs from current DB value (${maxMarks}). ` +
        `Marks will be validated against the current DB value (${maxMarks}).`
    );
  }

  // ── 4. Load active enrollments for this class-section ─────────────────────
  const classSectionRow = await db
    .select({ classSectionId: schoolExamsSchema.classSectionId })
    .from(schoolExamsSchema)
    .where(eq(schoolExamsSchema.id, examId))
    .get();

  if (!classSectionRow) {
    return { success: false, errors: ["Exam not found in database."] };
  }

  const validEnrollments = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          classSectionRow.classSectionId
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .all();

  const validEnrollmentSet = new Set(validEnrollments.map((e) => e.id));

  // ── 5. Read data rows ──────────────────────────────────────────────────────
  const dataWs = wb.getWorksheet("Marks Entry");
  if (!dataWs) {
    return {
      success: false,
      errors: [
        "'Marks Entry' sheet not found. Do not rename or delete sheets.",
      ],
    };
  }

  const rows: MarksRow[] = [];
  let skippedBlank = 0;

  dataWs.eachRow((row, rowNumber) => {
    if (rowNumber < DATA_START_ROW) return; // Skip header block

    const enrollmentId = row.getCell(COL.ENROLLMENT_ID).value;
    const marksObtainedRaw = row.getCell(COL.MARKS_OBTAINED).value;
    const remarksRaw = row.getCell(COL.REMARKS).value;

    // Skip summary row and empty rows
    if (enrollmentId === null || enrollmentId === undefined) return;
    if (typeof enrollmentId === "string" && isNaN(Number(enrollmentId))) return;

    // Skip rows with no marks entered (teacher intentionally left blank)
    if (
      marksObtainedRaw === null ||
      marksObtainedRaw === undefined ||
      marksObtainedRaw === ""
    ) {
      skippedBlank++;
      return;
    }

    const enrollId = Number(enrollmentId);
    const marksObtained = Number(marksObtainedRaw);
    const remarks = String(remarksRaw ?? "").trim();

    // Validate enrollment ID
    if (!validEnrollmentSet.has(enrollId)) {
      errors.push(
        `Row ${rowNumber}: Enrollment ID ${enrollId} is not valid for this class-section.`
      );
      return;
    }

    // Validate marks
    if (isNaN(marksObtained)) {
      errors.push(
        `Row ${rowNumber}: Marks Obtained must be a number (got "${marksObtainedRaw}").`
      );
      return;
    }
    if (!Number.isInteger(marksObtained)) {
      errors.push(
        `Row ${rowNumber}: Marks Obtained must be a whole number (got ${marksObtained}).`
      );
      return;
    }
    if (marksObtained < 0 || marksObtained > maxMarks) {
      errors.push(
        `Row ${rowNumber}: Marks Obtained (${marksObtained}) is out of range [0–${maxMarks}].`
      );
      return;
    }

    // Validate remarks length
    if (remarks.length > 500) {
      errors.push(`Row ${rowNumber}: Remarks must be under 500 characters.`);
      return;
    }

    rows.push({ enrollmentId: enrollId, marksObtained, remarks });
  });

  if (skippedBlank > 0) {
    warnings.push(
      `${skippedBlank} student row(s) with no marks entered were skipped.`
    );
  }

  if (rows.length === 0 && errors.length === 0) {
    return {
      success: false,
      errors: [
        "No marks found in the uploaded file. Please fill in the 'Marks Obtained' column before uploading.",
      ],
    };
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, examId, classSubjectId, rows, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE GRADE (server-side, matches card-templates logic)
// ─────────────────────────────────────────────────────────────────────────────
function computeGrade(marksObtained: number, maxMarks: number): string {
  const pct = (marksObtained / maxMarks) * 100;
  if (pct >= 90) return "A+";
  if (pct >= 80) return "A";
  if (pct >= 70) return "B+";
  if (pct >= 60) return "B";
  if (pct >= 50) return "C";
  if (pct >= 40) return "D";
  return "F";
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT MARKS FROM PARSED ROWS
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkUpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

/**
 * Performs an idempotent bulk upsert of marks inside a single DB transaction.
 * Re-uploading the same file is always safe.
 */
export async function bulkUpsertMarks(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  examId: number,
  classSubjectId: number,
  rows: MarksRow[],
  enteredBy: number,
  warnings: string[] = []
): Promise<BulkUpsertResult> {
  const db = await getSchoolDB(env, schoolCode);

  // Fetch maxMarks once for grade computation
  const examSubjectMeta = await db
    .select({ maxMarks: schoolExamSubjectsSchema.maxMarks })
    .from(schoolExamSubjectsSchema)
    .where(
      and(
        eq(schoolExamSubjectsSchema.examId, examId),
        eq(schoolExamSubjectsSchema.classSubjectId, classSubjectId)
      )
    )
    .get();

  if (!examSubjectMeta) throw new Error("Exam subject not found.");
  const { maxMarks } = examSubjectMeta;

  let inserted = 0;
  let updated = 0;
  const skipped = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const existing = await tx
        .select({ id: schoolExamMarksSchema.id })
        .from(schoolExamMarksSchema)
        .where(
          and(
            eq(schoolExamMarksSchema.examId, examId),
            eq(schoolExamMarksSchema.classSubjectId, classSubjectId),
            eq(schoolExamMarksSchema.enrollmentId, row.enrollmentId)
          )
        )
        .get();

      const grade = computeGrade(row.marksObtained, maxMarks);

      if (existing) {
        await tx
          .update(schoolExamMarksSchema)
          .set({
            marksObtained: row.marksObtained,
            grade,
            remarks: row.remarks,
            enteredBy,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schoolExamMarksSchema.id, existing.id));
        updated++;
      } else {
        await tx.insert(schoolExamMarksSchema).values({
          examId,
          classSubjectId,
          enrollmentId: row.enrollmentId,
          marksObtained: row.marksObtained,
          grade,
          remarks: row.remarks,
          enteredBy,
        });
        inserted++;
      }
    }
  });

  return { inserted, updated, skipped, warnings };
}
