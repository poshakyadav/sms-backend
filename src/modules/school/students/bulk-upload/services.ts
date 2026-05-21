// src/modules/school/students/bulk-upload/services.ts
// PRODUCTION-GRADE — v4
//
// Changes from v3:
//   • gender normalization fixed: "male" → "MALE" (matches schema enum MALE/FEMALE/TRANSGENDER)
//   • bloodGroup validation against allowed values before insert
//   • fatherName, motherName, guardianName, guardianRelation added to template + insert
//   • admissionNumber added to template + insert
//   • previousSchoolUdiseCode added to template + insert (with UDISE validator)
//   • socialCategory, religion, previousClassResult, enrollmentType added as optional columns
//   • rollNumber written to studentsSchema during insert
//   • addressLineOne/addressLineTwo column-name collision in findCol fixed
//   • UDISE format warnings extended: previousSchoolUdiseCode validated
//   • capacityInfo.remaining clamped correctly after partial failures
//   • academicYearId scoping issue fixed (resolved before transaction, asserted once)
//   • stateStudentId format-warning note added (state-specific, non-blocking)
//   • All new schoolUsersSchema fields written in INSERT
//   • Excel template header guidance comment added

import { and, eq, inArray, sql } from "drizzle-orm";
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
import {
  isValidAPAAR,
  isValidPEN,
  isValidUDISECode,
} from "../../../../utils/school/udise-validators";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed blood group values (matches schoolUsersSchema enum). */
const VALID_BLOOD_GROUPS = new Set([
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
]);

/** Allowed gender values (matches GenderValue enum: MALE/FEMALE/TRANSGENDER). */
const GENDER_NORMALIZER: Record<string, string> = {
  male: "MALE",
  m: "MALE",
  female: "FEMALE",
  f: "FEMALE",
  transgender: "TRANSGENDER",
  trans: "TRANSGENDER",
  t: "TRANSGENDER",
  other: "TRANSGENDER", // legacy Excel files may use "other"
};

/** Allowed enrollment type values. */
const VALID_ENROLLMENT_TYPES = new Set(["REGULAR", "PRIVATE", "OPEN_SCHOOL"]);

/** Allowed previous class result values. */
const VALID_PREVIOUS_CLASS_RESULTS = new Set([
  "PROMOTED",
  "NOT_PROMOTED",
  "NEW_ADMISSION",
  "TRANSFERRED",
]);

/** Social category — UDISE+ codes 1–5. */
const SOCIAL_CATEGORY_MAP: Record<string, number> = {
  "1": 1,
  general: 1,
  unreserved: 1,
  gen: 1,
  "2": 2,
  sc: 2,
  "scheduled caste": 2,
  "3": 3,
  st: 3,
  "scheduled tribe": 3,
  "4": 4,
  obc: 4,
  "other backward class": 4,
  "5": 5,
  "obc-ncl": 5,
  "obc ncl": 5,
};

/** Religion — UDISE+ codes 1–8. */
const RELIGION_MAP: Record<string, number> = {
  "1": 1,
  hindu: 1,
  "2": 2,
  muslim: 2,
  islam: 2,
  "3": 3,
  christian: 3,
  christianity: 3,
  "4": 4,
  sikh: 4,
  sikhism: 4,
  "5": 5,
  buddhist: 5,
  buddhism: 5,
  "6": 6,
  jain: 6,
  jainism: 6,
  "7": 7,
  others: 7,
  other: 7,
  "8": 8,
  "no religion": 8,
  none: 8,
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One parsed row from the Excel file.
 *
 * EXCEL TEMPLATE COLUMN HEADERS (case-insensitive, flexible matching):
 * ┌─────────────────────────────────┬──────────────────────────────────────────┐
 * │ Column Header                   │ Notes                                    │
 * ├─────────────────────────────────┼──────────────────────────────────────────┤
 * │ Name *                          │ Required. Student's full name.           │
 * │ Email *                         │ Required. Must be unique in the school.  │
 * │ Password *                      │ Required. Min 8 characters.             │
 * │ Phone                           │ Optional. Primary contact number.        │
 * │ Alternate Phone                 │ Optional.                                │
 * │ Date of Birth                   │ Optional. YYYY-MM-DD preferred.          │
 * │ Gender                          │ Optional. Male/Female/Transgender        │
 * │ Blood Group                     │ Optional. A+, A-, B+, B-, AB+, AB-, O+, O- │
 * │ Father Name                     │ Optional. UDISE+ required.               │
 * │ Mother Name                     │ Optional. UDISE+ required.               │
 * │ Guardian Name                   │ Optional.                                │
 * │ Guardian Relation               │ Optional. e.g., Grandfather              │
 * │ Address Line 1                  │ Optional. Street address.                │
 * │ Address Line 2                  │ Optional. Locality/area.                 │
 * │ City                            │ Optional.                                │
 * │ State                           │ Optional.                                │
 * │ Postal Code                     │ Optional. 6-digit Indian PIN code.       │
 * │ Admission Number                │ Optional. School's own ID.               │
 * │ Admission Date                  │ Optional. YYYY-MM-DD.                    │
 * │ Previous School                 │ Optional.                                │
 * │ Previous School UDISE Code      │ Optional. 11-digit UDISE code.           │
 * │ Previous Class Result           │ Optional. PROMOTED/NOT_PROMOTED/         │
 * │                                 │           NEW_ADMISSION/TRANSFERRED      │
 * │ Enrollment Type                 │ Optional. REGULAR/PRIVATE/OPEN_SCHOOL    │
 * │ Social Category                 │ Optional. 1=General,2=SC,3=ST,4=OBC,5=OBC-NCL │
 * │ Religion                        │ Optional. 1=Hindu,2=Muslim,...,8=No Religion │
 * │ Medical Info                    │ Optional. Allergies, conditions etc.     │
 * │ PEN                             │ Optional. 16-digit Permanent Edu Number. │
 * │ APAAR ID                        │ Optional. 12-digit APAAR/ABC ID.         │
 * │ State Student ID                │ Optional. SAMAGRA/state-specific ID.     │
 * └─────────────────────────────────┴──────────────────────────────────────────┘
 */
export interface BulkStudentRow {
  rowNumber: number;

  // ── Core (required) ───────────────────────────────────────────────────────
  name: string;
  email: string;
  password: string;

  // ── Contact (optional) ───────────────────────────────────────────────────
  phone?: string;
  alternatePhone?: string;

  // ── Personal (optional) ──────────────────────────────────────────────────
  dateOfBirth?: string;
  gender?: string; // Raw from Excel — normalized in insert
  bloodGroup?: string; // Raw from Excel — normalized in insert

  // ── Parental / guardian (optional — UDISE+ critical) ─────────────────────
  fatherName?: string;
  motherName?: string;
  guardianName?: string;
  guardianRelation?: string;

  // ── Address (optional) ───────────────────────────────────────────────────
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  state?: string;
  postalCode?: string;

  // ── School-internal (optional) ───────────────────────────────────────────
  admissionNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;
  rollNumber?: string;

  // ── UDISE academic (optional) ────────────────────────────────────────────
  enrollmentType?: string; // REGULAR / PRIVATE / OPEN_SCHOOL
  previousClassResult?: string; // PROMOTED / NOT_PROMOTED / NEW_ADMISSION / TRANSFERRED
  previousSchoolUdiseCode?: string; // 11-digit

  // ── UDISE demographic (optional) ─────────────────────────────────────────
  socialCategoryRaw?: string; // Parsed → integer 1–5 in insert
  religionRaw?: string; // Parsed → integer 1–8 in insert

  // ── UDISE / National Identity (optional) ─────────────────────────────────
  pen?: string; // 16-digit PEN
  apaarId?: string; // 12-digit APAAR/ABC ID
  stateStudentId?: string;
}

// ── UDISE format warning (non-blocking — row still inserts, field stored as-is) ──
export interface UDISEWarning {
  rowNumber: number;
  field: "pen" | "apaarId" | "previousSchoolUdiseCode";
  value: string;
  message: string;
}

// ── Conflict detail (for the "emails already exist" popup) ───────────────────
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
  udiseWarnings?: UDISEWarning[];
}

export interface BulkUploadResult {
  success: boolean;
  message: string;
  summary: {
    totalRows: number;
    successful: number;
    failed: number;
    skipped: number;
    udiseWarnings: number; // rows that succeeded but had UDISE format issues
  };
  results: BulkUploadRowResult[];
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

// ─────────────────────────────────────────────────────────────────────────────
// EXCEL PARSER
// ─────────────────────────────────────────────────────────────────────────────

async function parseExcelBuffer(
  fileBuffer: Uint8Array
): Promise<BulkStudentRow[]> {
  const XLSX = await import("xlsx");

  const workbook = XLSX.read(fileBuffer, { type: "array" });

  // Prefer a sheet named "students" — fall back to first sheet.
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

  // Normalise header row: lowercase + only alphanumeric/space chars.
  const headerRow: string[] = rawData[0].map((h: any) =>
    String(h)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  /**
   * Find the first header index that includes ALL of the given terms.
   * More specific matches (more terms) are preferred over generic ones.
   * Returns -1 when not found.
   *
   * IMPORTANT: Call more-specific lookups BEFORE less-specific ones to
   * avoid the "address" header matching both addressLineOne and addressLineTwo.
   */
  const findCol = (...patterns: string[][]): number => {
    // Try each pattern (ordered by specificity — caller controls order).
    for (const terms of patterns) {
      const idx = headerRow.findIndex((h) => terms.every((t) => h.includes(t)));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const colMap = {
    // ── Required ─────────────────────────────────────────────────────────────
    name: findCol(["student name"], ["full name"], ["name"]),
    email: findCol(["email address"], ["e mail"], ["email"]),
    password: findCol(["password"], ["pass"]),

    // ── Contact ──────────────────────────────────────────────────────────────
    phone: findCol(["phone"], ["mobile"], ["contact"]),
    // "alternate" must be checked BEFORE plain "phone" to avoid colMap.phone stealing it
    alternatePhone: findCol(
      ["alternate phone"],
      ["alt phone"],
      ["alternate mobile"],
      ["second phone"],
      ["other phone"],
      ["alternate contact"]
    ),

    // ── Personal ─────────────────────────────────────────────────────────────
    dateOfBirth: findCol(
      ["date of birth"],
      ["dob"],
      ["birth date"],
      ["birthdate"]
    ),
    gender: findCol(["gender"], ["sex"]),
    bloodGroup: findCol(["blood group"], ["blood type"], ["blood"]),

    // ── Parental / guardian (UDISE+ critical) ────────────────────────────────
    fatherName: findCol(
      ["father name"],
      ["father s name"],
      ["fathers name"],
      ["father"]
    ),
    motherName: findCol(
      ["mother name"],
      ["mother s name"],
      ["mothers name"],
      ["mother"]
    ),
    guardianName: findCol(["guardian name"], ["guardian s name"], ["guardian"]),
    guardianRelation: findCol(
      ["guardian relation"],
      ["relation"],
      ["relationship to student"]
    ),

    // ── Address — specific matches FIRST to avoid "address" collision ─────────
    // "address line 1" / "address line one" / "address1" → addressLineOne
    addressLineOne: findCol(
      ["address line 1"],
      ["address line one"],
      ["address1"],
      ["street address"]
    ),
    // "address line 2" / "address line two" / "address2" / "locality" → addressLineTwo
    // Plain "address" intentionally NOT a fallback here — it should map to addressLineOne only.
    addressLineTwo: findCol(
      ["address line 2"],
      ["address line two"],
      ["address2"],
      ["locality"]
    ),
    city: findCol(["city"], ["town"]),
    state: findCol(["state"], ["province"]),
    postalCode: findCol(
      ["postal code"],
      ["pin code"],
      ["pincode"],
      ["zip code"],
      ["postcode"]
    ),

    // ── School-internal ───────────────────────────────────────────────────────
    admissionNumber: findCol(
      ["admission number"],
      ["admission no"],
      ["reg number"],
      ["registration number"]
    ),
    admissionDate: findCol(["admission date"], ["joining date"]),
    rollNumber: findCol(["roll number"], ["roll no"], ["roll"]),
    previousSchool: findCol(
      ["previous school"],
      ["prev school"],
      ["last school"]
    ),
    medicalInfo: findCol(["medical info"], ["medical"], ["health info"]),

    // ── UDISE academic ────────────────────────────────────────────────────────
    enrollmentType: findCol(["enrollment type"], ["enrolment type"]),
    previousClassResult: findCol(
      ["previous class result"],
      ["prev class result"],
      ["class result"]
    ),
    previousSchoolUdiseCode: findCol(
      ["previous school udise"],
      ["prev school udise"],
      ["previous udise code"],
      ["udise code"]
    ),

    // ── UDISE demographic ─────────────────────────────────────────────────────
    socialCategory: findCol(
      ["social category"],
      ["caste category"],
      ["category"]
    ),
    religion: findCol(["religion"]),

    // ── UDISE / National Identity ─────────────────────────────────────────────
    pen: findCol(["pen"], ["permanent education number"], ["p e n"]),
    apaarId: findCol(["apaar id"], ["apaar"], ["abc id"]),
    stateStudentId: findCol(
      ["state student id"],
      ["state id"],
      ["samagra id"],
      ["udise student id"]
    ),
  };

  // Validate required columns.
  const missing: string[] = [];
  if (colMap.name === -1) missing.push("Name");
  if (colMap.email === -1) missing.push("Email");
  if (colMap.password === -1) missing.push("Password");
  if (missing.length > 0) {
    throw new Error(
      `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(
        ", "
      )}`
    );
  }

  const rows: BulkStudentRow[] = [];

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];

    // Skip completely empty rows.
    const isEmptyRow = row.every(
      (cell: any) => !cell || String(cell).trim() === ""
    );
    if (isEmptyRow) continue;

    /** Read cell as trimmed string; returns "" when column missing or empty. */
    const str = (colIdx: number): string => {
      if (colIdx === -1) return "";
      return String(row[colIdx] ?? "").trim();
    };

    rows.push({
      rowNumber: i + 1, // 1-based (row 1 = header)

      // ── Required ────────────────────────────────────────────────────────────
      name: str(colMap.name),
      email: str(colMap.email).toLowerCase(),
      password: str(colMap.password),

      // ── Contact ─────────────────────────────────────────────────────────────
      phone: str(colMap.phone) || undefined,
      alternatePhone: str(colMap.alternatePhone) || undefined,

      // ── Personal ─────────────────────────────────────────────────────────────
      dateOfBirth: str(colMap.dateOfBirth) || undefined,
      gender: str(colMap.gender) || undefined,
      bloodGroup: str(colMap.bloodGroup) || undefined,

      // ── Parental / guardian ───────────────────────────────────────────────────
      fatherName: str(colMap.fatherName) || undefined,
      motherName: str(colMap.motherName) || undefined,
      guardianName: str(colMap.guardianName) || undefined,
      guardianRelation: str(colMap.guardianRelation) || undefined,

      // ── Address ─────────────────────────────────────────────────────────────
      addressLineOne: str(colMap.addressLineOne) || undefined,
      addressLineTwo: str(colMap.addressLineTwo) || undefined,
      city: str(colMap.city) || undefined,
      state: str(colMap.state) || undefined,
      postalCode: str(colMap.postalCode) || undefined,

      // ── School-internal ──────────────────────────────────────────────────────
      admissionNumber: str(colMap.admissionNumber) || undefined,
      admissionDate: str(colMap.admissionDate) || undefined,
      rollNumber: str(colMap.rollNumber) || undefined,
      previousSchool: str(colMap.previousSchool) || undefined,
      medicalInfo: str(colMap.medicalInfo) || undefined,

      // ── UDISE academic ───────────────────────────────────────────────────────
      enrollmentType: str(colMap.enrollmentType).toUpperCase() || undefined,
      previousClassResult:
        str(colMap.previousClassResult).toUpperCase() || undefined,
      previousSchoolUdiseCode: str(colMap.previousSchoolUdiseCode) || undefined,

      // ── UDISE demographic (raw — resolved to codes in insert) ─────────────────
      socialCategoryRaw: str(colMap.socialCategory) || undefined,
      religionRaw: str(colMap.religion) || undefined,

      // ── UDISE / National Identity ─────────────────────────────────────────────
      pen: str(colMap.pen) || undefined,
      apaarId: str(colMap.apaarId) || undefined,
      stateStudentId: str(colMap.stateStudentId) || undefined,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW VALIDATOR — hard errors that block insert
// ─────────────────────────────────────────────────────────────────────────────

function validateRow(row: BulkStudentRow): string | null {
  if (!row.name || row.name.length < 2)
    return "Name must be at least 2 characters";

  if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
    return "Invalid email address";

  if (!row.password || row.password.length < 8)
    return "Password must be at least 8 characters";

  // Gender — only validate if provided; must resolve to a known value.
  if (row.gender) {
    const normalised = GENDER_NORMALIZER[row.gender.toLowerCase()];
    if (!normalised)
      return `Invalid gender "${row.gender}". Use: Male, Female, or Transgender`;
  }

  // Blood group — only validate if provided.
  if (row.bloodGroup) {
    const upper = row.bloodGroup.toUpperCase().replace(/\s/g, "");
    if (!VALID_BLOOD_GROUPS.has(upper))
      return `Invalid blood group "${row.bloodGroup}". Allowed: A+, A-, B+, B-, AB+, AB-, O+, O-`;
  }

  // Enrollment type — only validate if provided.
  if (row.enrollmentType && !VALID_ENROLLMENT_TYPES.has(row.enrollmentType)) {
    return `Invalid enrollment type "${row.enrollmentType}". Use: REGULAR, PRIVATE, or OPEN_SCHOOL`;
  }

  // Previous class result — only validate if provided.
  if (
    row.previousClassResult &&
    !VALID_PREVIOUS_CLASS_RESULTS.has(row.previousClassResult)
  ) {
    return `Invalid previous class result "${row.previousClassResult}". Use: PROMOTED, NOT_PROMOTED, NEW_ADMISSION, or TRANSFERRED`;
  }

  // Social category — must be parseable to 1–5 if provided.
  if (row.socialCategoryRaw) {
    const code = resolveSocialCategory(row.socialCategoryRaw);
    if (code === null)
      return `Invalid social category "${row.socialCategoryRaw}". Use 1–5 or: General, SC, ST, OBC, OBC-NCL`;
  }

  // Religion — must be parseable to 1–8 if provided.
  if (row.religionRaw) {
    const code = resolveReligion(row.religionRaw);
    if (code === null)
      return `Invalid religion "${row.religionRaw}". Use 1–8 or: Hindu, Muslim, Christian, Sikh, Buddhist, Jain, Others, No Religion`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// UDISE FORMAT WARNINGS — non-blocking (row inserts, field stored as-is)
// ─────────────────────────────────────────────────────────────────────────────

function collectUDISEWarnings(row: BulkStudentRow): UDISEWarning[] {
  const warnings: UDISEWarning[] = [];

  if (row.pen && !isValidPEN(row.pen)) {
    warnings.push({
      rowNumber: row.rowNumber,
      field: "pen",
      value: row.pen,
      message: `PEN "${row.pen}" is not a valid 16-digit number. It will be stored as-is for manual correction.`,
    });
  }

  if (row.apaarId && !isValidAPAAR(row.apaarId)) {
    warnings.push({
      rowNumber: row.rowNumber,
      field: "apaarId",
      value: row.apaarId,
      message: `APAAR ID "${row.apaarId}" is not a valid 12-digit number. It will be stored as-is for manual correction.`,
    });
  }

  if (
    row.previousSchoolUdiseCode &&
    !isValidUDISECode(row.previousSchoolUdiseCode)
  ) {
    warnings.push({
      rowNumber: row.rowNumber,
      field: "previousSchoolUdiseCode",
      value: row.previousSchoolUdiseCode,
      message: `Previous school UDISE code "${row.previousSchoolUdiseCode}" is not a valid 11-digit code. It will be stored as-is for manual correction.`,
    });
  }

  // stateStudentId: format varies by state — no hard format check, just store.
  // If a school needs state-specific validation, add it here in the future.

  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a raw social category string to the UDISE+ integer code (1–5). */
function resolveSocialCategory(raw: string): number | null {
  const normalised = raw.toLowerCase().trim();
  const code =
    SOCIAL_CATEGORY_MAP[normalised] ?? SOCIAL_CATEGORY_MAP[raw.trim()];
  return code ?? null;
}

/** Resolve a raw religion string to the UDISE+ integer code (1–8). */
function resolveReligion(raw: string): number | null {
  const normalised = raw.toLowerCase().trim();
  const code = RELIGION_MAP[normalised] ?? RELIGION_MAP[raw.trim()];
  return code ?? null;
}

/** Normalise gender string → schema enum value (MALE/FEMALE/TRANSGENDER). */
function normaliseGender(raw: string | undefined): string {
  if (!raw) return "";
  return GENDER_NORMALIZER[raw.toLowerCase().trim()] ?? "";
}

/** Normalise blood group string → uppercase canonical form. */
function normaliseBloodGroup(raw: string | undefined): string {
  if (!raw) return "";
  return raw.toUpperCase().replace(/\s/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET CAPACITY INFO
// ─────────────────────────────────────────────────────────────────────────────

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
      capacity: schoolClassSectionsSchema.capacity,
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

  const maxAllowed = classSection.capacity;

  const currentYear = await db
    .select({ id: schoolAcademicYearsSchema.id })
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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BULK UPLOAD SERVICE
// ─────────────────────────────────────────────────────────────────────────────

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

  // ── 1. Parse Excel ─────────────────────────────────────────────────────────
  let rows: BulkStudentRow[];
  try {
    rows = await parseExcelBuffer(input.fileBuffer);
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to parse Excel file: ${err.message}`,
      summary: {
        totalRows: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        udiseWarnings: 0,
      },
      results: [],
    };
  }

  if (rows.length === 0) {
    return {
      success: false,
      message: "No data rows found in the Excel file",
      summary: {
        totalRows: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        udiseWarnings: 0,
      },
      results: [],
    };
  }

  // ── 2. Validate class-section ───────────────────────────────────────────────
  const classSection = await db
    .select({
      id: schoolClassSectionsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      isActive: schoolClassSectionsSchema.isActive,
      capacity: schoolClassSectionsSchema.capacity,
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
        udiseWarnings: 0,
      },
      results: [],
    };
  }

  if (!classSection.isActive) {
    return {
      success: false,
      message: `Class-section ${classSection.className} – ${classSection.sectionName} is inactive`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
        udiseWarnings: 0,
      },
      results: [],
    };
  }

  const maxAllowed = classSection.capacity;

  // ── 3. Resolve academic year (fail fast before any heavy work) ─────────────
  let resolvedAcademicYearId: number;

  if (input.academicYearId) {
    resolvedAcademicYearId = input.academicYearId;
  } else {
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
          udiseWarnings: 0,
        },
        results: [],
      };
    }
    resolvedAcademicYearId = currentYear.id;
  }

  // ── 4. Capacity check ──────────────────────────────────────────────────────
  const existingCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, input.classSectionId),
        eq(
          schoolStudentEnrollmentsSchema.academicYearId,
          resolvedAcademicYearId
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  const existingStudents = existingCountResult?.count ?? 0;
  const availableSlots = maxAllowed - existingStudents;

  if (availableSlots <= 0) {
    return {
      success: false,
      message: `${classSection.className} – ${classSection.sectionName} is full (${existingStudents}/${maxAllowed} students). No more students can be added.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
        udiseWarnings: 0,
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
      } available in ${classSection.className} – ${
        classSection.sectionName
      } (${existingStudents}/${maxAllowed} enrolled). Please reduce your file to ${availableSlots} or fewer students.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
        udiseWarnings: 0,
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

  // ── 5. PRE-FLIGHT EMAIL VALIDATION ─────────────────────────────────────────
  // Detect ALL conflicts before any insert so the frontend can show the full
  // list in one go. No students are inserted if any conflict is found.
  const emailConflicts: EmailConflict[] = [];
  const seenEmails = new Map<string, number>(); // email → first rowNumber

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
        // Don't double-report a row already flagged as DUPLICATE_IN_FILE.
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
        udiseWarnings: 0,
      },
      results: [],
      emailConflicts,
    };
  }

  // ── 6. Per-row field validation ─────────────────────────────────────────────
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
        udiseWarnings: 0,
      },
      results: rowResults,
    };
  }

  // ── 7. Get STUDENT role ID ──────────────────────────────────────────────────
  const studentRole = await db
    .select({ id: schoolRolesSchema.id })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.name, SchoolRole.STUDENT))
    .get();

  if (!studentRole) {
    return {
      success: false,
      message: "STUDENT role not found in this school. Please contact support.",
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: rows.length,
        skipped: 0,
        udiseWarnings: 0,
      },
      results: [],
    };
  }

  // ── 8. Insert valid rows (one transaction per student — partial success ok) ──
  //
  // Design intent: If row 3 of 10 fails (e.g. DB constraint on admissionNumber),
  // rows 1, 2, 4-10 are not rolled back. The caller receives a 207 with per-row
  // status so the operator can fix and re-upload only the failed rows.
  // Email conflicts (step 5) catch the most common failure mode before any inserts.

  let successCount = 0;
  let failCount = rowResults.filter((r) => r.status === "FAILED").length;
  let udiseWarningCount = 0;

  for (const row of validRows) {
    // Collect non-blocking UDISE format warnings before insert.
    const udiseWarnings = collectUDISEWarnings(row);

    try {
      const userId = await db.transaction(async (tx) => {
        const passwordHash = await hashPassword(row.password);

        // ── Resolve UDISE demographic codes ─────────────────────────────────
        const socialCategory = row.socialCategoryRaw
          ? resolveSocialCategory(row.socialCategoryRaw)
          : null;
        const religion = row.religionRaw
          ? resolveReligion(row.religionRaw)
          : null;

        // ── Resolve gender (MALE/FEMALE/TRANSGENDER) ─────────────────────────
        const genderValue = normaliseGender(row.gender);

        // ── Resolve blood group (e.g. "a+" → "A+") ──────────────────────────
        const bloodGroupValue = normaliseBloodGroup(row.bloodGroup);

        // ── Insert school_users (base record — all shared fields) ────────────
        const [newUser] = await tx
          .insert(schoolUsersSchema)
          .values({
            name: row.name,
            email: row.email,
            passwordHash,
            primaryRole: SchoolRole.STUDENT,

            // ── Contact ───────────────────────────────────────────────────────
            phone: row.phone || "",
            alternatePhone: row.alternatePhone || "",

            // ── Personal ─────────────────────────────────────────────────────
            dateOfBirth: row.dateOfBirth || "",
            gender: genderValue as any,
            bloodGroup: bloodGroupValue,
            avatarUrl: "",

            // ── Parental / guardian (UDISE+ critical) ─────────────────────────
            fatherName: row.fatherName || "",
            motherName: row.motherName || "",
            guardianName: row.guardianName || "",
            guardianRelation: row.guardianRelation || "",

            // ── Address ──────────────────────────────────────────────────────
            addressLineOne: row.addressLineOne || "",
            addressLineTwo: row.addressLineTwo || "",
            city: row.city || "",
            state: row.state || "",
            postalCode: row.postalCode || "",

            // ── System ────────────────────────────────────────────────────────
            tokenVersion: 0,
            isActive: true,
          })
          .returning({ id: schoolUsersSchema.id });

        // ── Assign STUDENT role ──────────────────────────────────────────────
        await tx.insert(schoolUserRolesSchema).values({
          userId: newUser.id,
          roleId: studentRole.id,
        });

        // ── Insert student profile (includes all UDISE fields) ───────────────
        await tx.insert(studentsSchema).values({
          userId: newUser.id,

          // ── School-internal ─────────────────────────────────────────────────
          admissionNumber: row.admissionNumber || null,
          admissionDate: row.admissionDate || "",
          rollNumber: row.rollNumber || "",
          previousSchool: row.previousSchool || "",
          medicalInfo: row.medicalInfo || "",

          // ── UDISE academic ──────────────────────────────────────────────────
          enrollmentType: (row.enrollmentType &&
          VALID_ENROLLMENT_TYPES.has(row.enrollmentType)
            ? row.enrollmentType
            : "REGULAR") as any,
          previousClassResult: (row.previousClassResult || null) as any,
          previousSchoolUdiseCode: row.previousSchoolUdiseCode || null,

          // ── UDISE demographic ────────────────────────────────────────────────
          socialCategory: (socialCategory ?? null) as any,
          religion: (religion ?? null) as any,

          // ── UDISE / National Identity ────────────────────────────────────────
          pen: row.pen || null,
          apaarId: row.apaarId || null,
          stateStudentId: row.stateStudentId || null,

          // ── Verification flags (always false on bulk upload) ──────────────────
          isAadhaarVerified: false,
          udiseVerified: false,

          // ── Defaults ─────────────────────────────────────────────────────────
          isMinority: false,
          isBpl: false,
          isCwsn: false,
          hasDisabilityCertificate: false,
          facilitiesReceived: "[]",
        });

        // ── Enroll in class-section ──────────────────────────────────────────
        await tx.insert(schoolStudentEnrollmentsSchema).values({
          studentId: newUser.id,
          academicYearId: resolvedAcademicYearId,
          classSectionId: input.classSectionId,
          isActive: true,
        });

        return newUser.id;
      }); // end transaction

      if (udiseWarnings.length > 0) udiseWarningCount++;

      // ── Fire-and-forget welcome email ────────────────────────────────────────
      sendTransactionalEmail(env, {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: row.email, name: row.name }],
        subject: `Welcome to ${schoolCode} School Portal`,
        htmlContent: `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;">
            <h2 style="color:#1e293b;margin:0 0 8px">Welcome, ${row.name}!</h2>
            <p style="color:#475569;margin:0 0 20px">
              Your student account has been created for
              <strong>${classSection.className} – ${classSection.sectionName}</strong>.
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin:0 0 20px">
              <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Login Email</p>
              <p style="margin:0 0 16px;color:#1e293b;font-weight:600;font-size:15px">${row.email}</p>
              <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Temporary Password</p>
              <p style="margin:0;color:#1e293b;font-weight:600;font-size:15px">${row.password}</p>
            </div>
            <p style="color:#f59e0b;font-size:13px;margin:0">
              ⚠️ Please change your password after your first login.
            </p>
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
        udiseWarnings: udiseWarnings.length > 0 ? udiseWarnings : undefined,
      });
      successCount++;
    } catch (err: any) {
      console.error(
        `Bulk upload: failed to process row ${row.rowNumber} (${row.email}):`,
        err
      );
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

  // ── 9. Sort results by original row order and build final response ──────────
  rowResults.sort((a, b) => a.rowNumber - b.rowNumber);

  const allSuccess = successCount === rows.length;
  const partialSuccess = successCount > 0 && failCount > 0;

  let message: string;
  if (allSuccess) {
    message = `Successfully added ${successCount} student${
      successCount !== 1 ? "s" : ""
    } to ${classSection.className} – ${classSection.sectionName}.`;
    if (udiseWarningCount > 0) {
      message += ` Note: ${udiseWarningCount} student${
        udiseWarningCount !== 1 ? "s have" : " has"
      } UDISE field format issues — please review and correct from the student profile.`;
    }
  } else if (partialSuccess) {
    message = `Partially completed: ${successCount} student${
      successCount !== 1 ? "s" : ""
    } added, ${failCount} failed.`;
    if (udiseWarningCount > 0) {
      message += ` ${udiseWarningCount} student${
        udiseWarningCount !== 1 ? "s" : ""
      } added with UDISE format warnings.`;
    }
  } else {
    message = `Upload failed: all ${failCount} rows had errors.`;
  }

  // Clamp remaining: account for partial failures (those slots stay available).
  const actualAdded = successCount;
  const remaining = Math.max(0, availableSlots - actualAdded);

  return {
    success: allSuccess || partialSuccess,
    message,
    summary: {
      totalRows: rows.length,
      successful: successCount,
      failed: failCount,
      skipped: 0,
      udiseWarnings: udiseWarningCount,
    },
    results: rowResults,
    capacityInfo: {
      existingStudents,
      addedStudents: actualAdded,
      totalAfter: existingStudents + actualAdded,
      maxAllowed,
      remaining,
    },
  };
}
