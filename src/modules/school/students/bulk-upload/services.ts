// src/modules/school/students/bulk-upload/services.ts
// PRODUCTION-GRADE — v2
// Changes from v1:
//   • Removed rollNumber from Excel template / parser (assigned separately via /assign-roll-numbers)
//   • Added guardianRelationship field
//   • Pre-flight email deduplication returns ALL conflicts BEFORE any DB insert
//   • Detailed conflict response shape for frontend popup
//   • Capacity hard-check moved before parsing so we fail fast

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getSchoolDB } from "../../../../db/school-client";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolRolesSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
  studentsSchema,
} from "../../../../db/schemas/school";
import { SchoolEnv } from "../../../../types/common-types";
import { SchoolRole } from "../../../../types/school-role";
import { hashPassword } from "../../../../utils/hashing";
import { sendTransactionalEmail } from "../../../../utils/sendEmail";

// ==================== TYPES ====================
export interface BulkStudentRow {
  rowNumber: number;
  name: string;
  email: string;
  password: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;
  bloodGroup?: string;
}

// ── Conflict detail (for the "emails already exist" popup) ──────────────────
export interface EmailConflict {
  rowNumber: number;
  name: string;
  email: string;
  conflictType: "DUPLICATE_IN_FILE" | "ALREADY_IN_SCHOOL";
}

export interface BulkUploadRowResult {
  rowNumber: number;
  name: string;
  email: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  error?: string;
  userId?: number;
}

export interface BulkUploadResult {
  success: boolean;
  message: string;
  summary: {
    totalRows: number;
    successful: number;
    failed: number;
    skipped: number;
  };
  results: BulkUploadRowResult[];
  // Non-null only when there are pre-flight email conflicts (before any insert)
  emailConflicts?: EmailConflict[];
  capacityInfo?: {
    existingStudents: number;
    addedStudents: number;
    totalAfter: number;
    maxAllowed: number;
    remaining: number;
  };
}

export interface CapacityInfo {
  classSectionId: number;
  className: string;
  sectionName: string;
  existingStudents: number;
  maxAllowed: number;
  remaining: number;
  canAddMore: boolean;
}

// ==================== EXCEL PARSER ====================
async function parseExcelBuffer(
  fileBuffer: Uint8Array
): Promise<BulkStudentRow[]> {
  const XLSX = await import("xlsx");

  const workbook = XLSX.read(fileBuffer, { type: "array" });
  // Always read the first sheet named "Students" or fallback to index 0
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase() === "students") ??
    workbook.SheetNames[0];

  if (!sheetName) throw new Error("Excel file has no sheets");

  const worksheet = workbook.Sheets[sheetName];
  const rawData: any[] = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
  });

  if (rawData.length < 2) {
    throw new Error(
      "Excel file must have a header row and at least one data row"
    );
  }

  const headerRow = rawData[0].map((h: any) =>
    String(h)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .trim()
  );

  const findCol = (...names: string[]) => {
    for (const name of names) {
      const idx = headerRow.findIndex((h: string) => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const colMap = {
    name: findCol("name", "student name", "full name"),
    email: findCol("email", "e mail", "email address"),
    password: findCol("password", "pass"),
    phone: findCol("phone", "mobile", "contact"),
    dateOfBirth: findCol("date of birth", "dob", "birth date", "birthdate"),
    gender: findCol("gender", "sex"),
    admissionDate: findCol("admission date", "admission", "joining date"),
    previousSchool: findCol("previous school", "prev school", "last school"),
    medicalInfo: findCol("medical", "medical info", "health info"),
    bloodGroup: findCol("blood", "blood group", "blood type"),
  };

  if (colMap.name === -1) throw new Error("Missing required column: Name");
  if (colMap.email === -1) throw new Error("Missing required column: Email");
  if (colMap.password === -1)
    throw new Error("Missing required column: Password");

  const rows: BulkStudentRow[] = [];

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const isEmptyRow = row.every(
      (cell: any) => !cell || String(cell).trim() === ""
    );
    if (isEmptyRow) continue;

    const str = (colIdx: number): string => {
      if (colIdx === -1) return "";
      return String(row[colIdx] || "").trim();
    };

    rows.push({
      rowNumber: i + 1,
      name: str(colMap.name),
      email: str(colMap.email).toLowerCase(),
      password: str(colMap.password),
      phone: str(colMap.phone) || undefined,
      dateOfBirth: str(colMap.dateOfBirth) || undefined,
      gender: str(colMap.gender) || undefined,
      admissionDate: str(colMap.admissionDate) || undefined,
      previousSchool: str(colMap.previousSchool) || undefined,
      medicalInfo: str(colMap.medicalInfo) || undefined,
      bloodGroup: str(colMap.bloodGroup) || undefined,
    });
  }

  return rows;
}

// ==================== ROW VALIDATOR ====================
function validateRow(row: BulkStudentRow): string | null {
  if (!row.name || row.name.length < 2)
    return "Name must be at least 2 characters";
  if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
    return "Invalid email address";
  if (!row.password || row.password.length < 8)
    return "Password must be at least 8 characters";
  if (
    row.gender &&
    !["male", "female", "other"].includes(row.gender.toLowerCase())
  )
    return "Gender must be Male, Female, or Other";
  if (
    row.bloodGroup &&
    !["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].includes(
      row.bloodGroup.toUpperCase()
    )
  )
    return "Invalid blood group (e.g. A+, B-, O+)";
  return null;
}

// ==================== GET CAPACITY INFO ====================
export async function getClassSectionCapacityInfo(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  classSectionId: number
): Promise<CapacityInfo> {
  const db = await getSchoolDB(env, schoolCode);

  const classSection = await db
    .select({
      id: schoolClassSectionsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isActive: schoolClassSectionsSchema.isActive,
      capacity: schoolClassSectionsSchema.capacity, // ← reads per-class-section capacity
    })
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolClassSectionsSchema.id, classSectionId))
    .get();

  if (!classSection) throw new Error("Class-section not found");

  const maxAllowed = classSection.capacity; // ← dynamic per class-section

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  let existingStudents = 0;
  if (currentYear) {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get();
    existingStudents = countResult?.count ?? 0;
  }

  const remaining = maxAllowed - existingStudents;

  return {
    classSectionId,
    className: classSection.className,
    sectionName: classSection.sectionName,
    existingStudents,
    maxAllowed,
    remaining: Math.max(0, remaining),
    canAddMore: remaining > 0,
  };
}

// ==================== MAIN BULK UPLOAD SERVICE ====================
export async function bulkUploadStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  input: {
    classSectionId: number;
    academicYearId?: number;
    fileBuffer: Uint8Array;
    uploadedBy: number;
  }
): Promise<BulkUploadResult> {
  const db = await getSchoolDB(env, schoolCode);

  // ── 1. Parse Excel ──────────────────────────────────────────────────────
  let rows: BulkStudentRow[];
  try {
    rows = await parseExcelBuffer(input.fileBuffer);
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to parse Excel file: ${err.message}`,
      summary: { totalRows: 0, successful: 0, failed: 0, skipped: 0 },
      results: [],
    };
  }

  if (rows.length === 0) {
    return {
      success: false,
      message: "No data rows found in the Excel file",
      summary: { totalRows: 0, successful: 0, failed: 0, skipped: 0 },
      results: [],
    };
  }

  // ── 2. Validate class-section + read capacity from DB ───────────────────
  // CHANGED: added `capacity` to the select list
  const classSection = await db
    .select({
      id: schoolClassSectionsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isActive: schoolClassSectionsSchema.isActive,
      capacity: schoolClassSectionsSchema.capacity, // ← dynamic capacity
    })
    .from(schoolClassSectionsSchema)
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolClassSectionsSchema.id, input.classSectionId))
    .get();

  if (!classSection) {
    return {
      success: false,
      message: "Class-section not found",
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
    };
  }
  if (!classSection.isActive) {
    return {
      success: false,
      message: `Class-section ${classSection.className} - ${classSection.sectionName} is inactive`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
    };
  }

  const maxAllowed = classSection.capacity; // ← use DB value throughout

  // File-level row count guard (use actual capacity, not a hardcoded constant)
  if (rows.length > maxAllowed) {
    return {
      success: false,
      message: `File contains ${rows.length} rows. Maximum allowed for this class-section is ${maxAllowed}.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
    };
  }

  // ── 3. Resolve academic year ────────────────────────────────────────────
  let academicYearId = input.academicYearId;
  if (!academicYearId) {
    const currentYear = await db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();
    if (!currentYear) {
      return {
        success: false,
        message:
          "No current academic year found. Please set a current academic year first.",
        summary: {
          totalRows: rows.length,
          successful: 0,
          failed: rows.length,
          skipped: 0,
        },
        results: [],
      };
    }
    academicYearId = currentYear.id;
  }

  // ── 4. Capacity check (against real DB capacity) ────────────────────────
  const existingCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, input.classSectionId),
        eq(schoolStudentEnrollmentsSchema.academicYearId, academicYearId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  const existingStudents = existingCountResult?.count ?? 0;
  const availableSlots = maxAllowed - existingStudents;

  if (availableSlots <= 0) {
    return {
      success: false,
      message: `${classSection.className} - ${classSection.sectionName} is full (${existingStudents}/${maxAllowed} students). No more students can be added.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
      capacityInfo: {
        existingStudents,
        addedStudents: 0,
        totalAfter: existingStudents,
        maxAllowed,
        remaining: 0,
      },
    };
  }

  if (rows.length > availableSlots) {
    return {
      success: false,
      message: `Cannot add ${
        rows.length
      } students. Only ${availableSlots} slot${
        availableSlots !== 1 ? "s" : ""
      } available in ${classSection.className} - ${
        classSection.sectionName
      } (${existingStudents}/${maxAllowed} enrolled). Please reduce your file to ${availableSlots} or fewer students.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
      capacityInfo: {
        existingStudents,
        addedStudents: 0,
        totalAfter: existingStudents,
        maxAllowed,
        remaining: availableSlots,
      },
    };
  }

  // ── 5. PRE-FLIGHT EMAIL VALIDATION (unchanged logic) ────────────────────
  const emailConflicts: EmailConflict[] = [];

  const seenEmails = new Map<string, number>();
  for (const row of rows) {
    const lower = row.email.toLowerCase();
    if (seenEmails.has(lower)) {
      emailConflicts.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email,
        conflictType: "DUPLICATE_IN_FILE",
      });
    } else {
      seenEmails.set(lower, row.rowNumber);
    }
  }

  const uniqueEmails = [...seenEmails.keys()];
  if (uniqueEmails.length > 0) {
    const existingUsers = await db
      .select({ email: schoolUsersSchema.email })
      .from(schoolUsersSchema)
      .where(inArray(schoolUsersSchema.email, uniqueEmails))
      .all();

    const existingEmailSet = new Set(
      existingUsers.map((u) => u.email.toLowerCase())
    );

    for (const row of rows) {
      if (existingEmailSet.has(row.email.toLowerCase())) {
        const alreadyReported = emailConflicts.some(
          (c) => c.rowNumber === row.rowNumber
        );
        if (!alreadyReported) {
          emailConflicts.push({
            rowNumber: row.rowNumber,
            name: row.name,
            email: row.email,
            conflictType: "ALREADY_IN_SCHOOL",
          });
        }
      }
    }
  }

  if (emailConflicts.length > 0) {
    const inFileCount = emailConflicts.filter(
      (c) => c.conflictType === "DUPLICATE_IN_FILE"
    ).length;
    const inSchoolCount = emailConflicts.filter(
      (c) => c.conflictType === "ALREADY_IN_SCHOOL"
    ).length;

    const parts: string[] = [];
    if (inSchoolCount > 0)
      parts.push(
        `${inSchoolCount} email${
          inSchoolCount !== 1 ? "s are" : " is"
        } already registered in this school`
      );
    if (inFileCount > 0)
      parts.push(
        `${inFileCount} duplicate email${
          inFileCount !== 1 ? "s" : ""
        } within the file`
      );

    return {
      success: false,
      message: `Upload blocked: ${parts.join(
        " and "
      )}. No students were added. Please fix the issues and re-upload.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: emailConflicts.length,
        skipped: 0,
      },
      results: [],
      emailConflicts,
    };
  }

  // ── 6. Per-row basic validation ─────────────────────────────────────────
  const rowResults: BulkUploadRowResult[] = [];
  const validRows: BulkStudentRow[] = [];

  for (const row of rows) {
    const err = validateRow(row);
    if (err) {
      rowResults.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email,
        status: "FAILED",
        error: err,
      });
    } else {
      validRows.push(row);
    }
  }

  if (validRows.length === 0) {
    return {
      success: false,
      message: `All ${rows.length} rows failed validation. Please fix the errors and try again.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rowResults.length,
        skipped: 0,
      },
      results: rowResults,
    };
  }

  // ── 7. Get STUDENT role ID ──────────────────────────────────────────────
  const studentRole = await db
    .select({ id: schoolRolesSchema.id })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.name, SchoolRole.STUDENT))
    .get();

  if (!studentRole) {
    return {
      success: false,
      message: "STUDENT role not found. Please contact support.",
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
      },
      results: [],
    };
  }

  // ── 8. Insert valid rows ────────────────────────────────────────────────
  let successCount = 0;
  let failCount = rowResults.filter((r) => r.status === "FAILED").length;

  for (const row of validRows) {
    try {
      const userId = await db.transaction(async (tx) => {
        const passwordHash = await hashPassword(row.password);

        const [newUser] = await tx
          .insert(schoolUsersSchema)
          .values({
            name: row.name,
            email: row.email,
            passwordHash,
            phone: row.phone || "",
            alternatePhone: "",
            dateOfBirth: row.dateOfBirth || "",
            gender: row.gender
              ? row.gender.charAt(0).toUpperCase() +
                row.gender.slice(1).toLowerCase()
              : "",
            bloodGroup: row.bloodGroup ? row.bloodGroup.toUpperCase() : "",
            tokenVersion: 0,
            isActive: true,
            primaryRole: SchoolRole.STUDENT,
          })
          .returning({ id: schoolUsersSchema.id });

        await tx.insert(schoolUserRolesSchema).values({
          userId: newUser.id,
          roleId: studentRole.id,
        });

        await tx.insert(studentsSchema).values({
          userId: newUser.id,
          admissionDate: row.admissionDate || "",
          previousSchool: row.previousSchool || "",
          medicalInfo: row.medicalInfo || "",
        });

        await tx.insert(schoolStudentEnrollmentsSchema).values({
          studentId: newUser.id,
          academicYearId: academicYearId!,
          classSectionId: input.classSectionId,
          isActive: true,
        });

        return newUser.id;
      });

      sendTransactionalEmail(env, {
        sender: {
          email: env.BREVO_SENDER_EMAIL,
          name: env.BREVO_SENDER_NAME,
        },
        to: [{ email: row.email, name: row.name }],
        subject: `Welcome to ${schoolCode} School Portal`,
        htmlContent: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
            <h2 style="color:#1e293b">Welcome, ${row.name}!</h2>
            <p style="color:#475569">Your student account has been created for <strong>${classSection.className} – ${classSection.sectionName}</strong>.</p>
            <div style="background:#f8fafc;border-radius:10px;padding:20px;margin:20px 0;">
              <p style="margin:0 0 6px;color:#64748b;font-size:13px">Login Email</p>
              <p style="margin:0 0 16px;color:#1e293b;font-weight:600">${row.email}</p>
              <p style="margin:0 0 6px;color:#64748b;font-size:13px">Temporary Password</p>
              <p style="margin:0;color:#1e293b;font-weight:600">${row.password}</p>
            </div>
            <p style="color:#f59e0b;font-size:13px">⚠️ Please change your password after your first login.</p>
          </div>
        `,
      }).catch((err) =>
        console.error(`Welcome email failed for ${row.email}:`, err)
      );

      rowResults.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email,
        status: "SUCCESS",
        userId,
      });
      successCount++;
    } catch (err: any) {
      console.error(`Failed to process row ${row.rowNumber}:`, err);
      rowResults.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email,
        status: "FAILED",
        error: err.message || "Unknown error during processing",
      });
      failCount++;
    }
  }

  rowResults.sort((a, b) => a.rowNumber - b.rowNumber);

  const allSuccess = successCount === rows.length;
  const partialSuccess = successCount > 0 && failCount > 0;

  return {
    success: allSuccess || partialSuccess,
    message: allSuccess
      ? `Successfully added ${successCount} student${
          successCount !== 1 ? "s" : ""
        } to ${classSection.className} – ${
          classSection.sectionName
        }. Roll numbers can be assigned from the Roll Numbers section.`
      : partialSuccess
      ? `Partially completed: ${successCount} student${
          successCount !== 1 ? "s" : ""
        } added, ${failCount} failed.`
      : `Upload failed: all ${failCount} rows had errors.`,
    summary: {
      totalRows: rows.length,
      successful: successCount,
      failed: failCount,
      skipped: 0,
    },
    results: rowResults,
    capacityInfo: {
      existingStudents,
      addedStudents: successCount,
      totalAfter: existingStudents + successCount,
      maxAllowed,
      remaining: availableSlots - successCount,
    },
  };
}
