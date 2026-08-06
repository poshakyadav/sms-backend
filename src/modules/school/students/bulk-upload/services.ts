// src/modules/school/students/bulk-upload/services.ts

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
// ↓ Import from the CENTRAL hashing utility — single source of truth
import { hashPasswordFast } from "../../../../utils/hashing";
import { sendTransactionalEmail } from "../../../../utils/sendEmail";
import {
  isValidAPAAR,
  isValidPEN,
  isValidUDISECode,
} from "../../../../utils/school/udise-validators";
import { isUniqueConstraintError } from "../../../../utils/db-errors";
import {
  buildUsernameBase,
  isValidUsernameFormat,
  normalizeUsername,
  randomUsernameSuffix,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../../../../utils/school/username";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

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

const GENDER_NORMALIZER: Record<string, string> = {
  male: "MALE",
  m: "MALE",
  female: "FEMALE",
  f: "FEMALE",
  transgender: "TRANSGENDER",
  trans: "TRANSGENDER",
  t: "TRANSGENDER",
  other: "TRANSGENDER",
};

const VALID_ENROLLMENT_TYPES = new Set(["REGULAR", "PRIVATE", "OPEN_SCHOOL"]);

const VALID_PREVIOUS_CLASS_RESULTS = new Set([
  "PROMOTED",
  "NOT_PROMOTED",
  "NEW_ADMISSION",
  "TRANSFERRED",
]);

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

export interface BulkStudentRow {
  rowNumber: number;
  name: string;
  email?: string; // now optional — a row may have no email
  username?: string; // optional; auto-generated (name+class+section) if omitted
  password: string;
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: string;
  gender?: string;
  bloodGroup?: string;
  fatherName?: string;
  motherName?: string;
  guardianName?: string;
  guardianRelation?: string;
  addressLineOne?: string;
  addressLineTwo?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  admissionNumber?: string;
  admissionDate?: string;
  previousSchool?: string;
  medicalInfo?: string;
  rollNumber?: string;
  enrollmentType?: string;
  previousClassResult?: string;
  previousSchoolUdiseCode?: string;
  socialCategoryRaw?: string;
  religionRaw?: string;
  pen?: string;
  apaarId?: string;
  stateStudentId?: string;
}

export interface UDISEWarning {
  rowNumber: number;
  field: "pen" | "apaarId" | "previousSchoolUdiseCode";
  value: string;
  message: string;
}

export interface EmailConflict {
  rowNumber: number;
  name: string;
  email: string;
  conflictType: "DUPLICATE_IN_FILE" | "ALREADY_IN_SCHOOL";
}

/** Mirrors EmailConflict — for explicit (admin-typed) usernames that collide. */
export interface UsernameConflict {
  rowNumber: number;
  name: string;
  username: string;
  conflictType: "DUPLICATE_IN_FILE" | "ALREADY_IN_SCHOOL";
}

export interface BulkUploadRowResult {
  rowNumber: number;
  name: string;
  email: string;
  username?: string; // populated on SUCCESS — the only place to find an
  // auto-generated or admin-supplied username, especially important now
  // that a row may have no email to communicate credentials through.
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
    udiseWarnings: number;
  };
  results: BulkUploadRowResult[];
  emailConflicts?: EmailConflict[];
  usernameConflicts?: UsernameConflict[];
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
  const workbook = XLSX.read(fileBuffer, { type: "array", cellDates: true });
  const sheetName =
    workbook.SheetNames.find((n: string) => n.toLowerCase() === "students") ??
    workbook.SheetNames[0];

  if (!sheetName) throw new Error("Excel file has no sheets");

  const worksheet = workbook.Sheets[sheetName];
  const rawData: any[][] = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
  });

  if (rawData.length === 0)
    throw new Error(
      "Excel file is empty. Please use the provided student upload template."
    );

  const normaliseCell = (v: any): string =>
    String(v ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  const isHeaderRow = (row: any[]): boolean => {
    const cells = row.map(normaliseCell);
    return (
      cells.some((c) => c === "name" || c.startsWith("name")) &&
      cells.some((c) => c === "email" || c.startsWith("email")) &&
      cells.some((c) => c === "password" || c.startsWith("password"))
    );
  };

  const headerRowIndex = rawData.findIndex(isHeaderRow);
  if (headerRowIndex === -1)
    throw new Error(
      "Could not find the header row in the Excel file. " +
      "Make sure you are using the official student upload template and have NOT " +
      'renamed or removed the "Name *", "Email", or "Password *" column headers.'
    );

  const hintRowIndex = headerRowIndex + 1;
  const SAMPLE_ROW_COUNT = 2;
  const dataStartIndex = hintRowIndex + 1 + SAMPLE_ROW_COUNT;

  if (dataStartIndex >= rawData.length)
    throw new Error(
      "Excel file has a header row but no data rows. " +
      `Please fill in your student data starting from row ${dataStartIndex + 1
      } ` +
      "(below the two sample rows shown in blue and green) and re-upload."
    );

  const headerRow: string[] = rawData[headerRowIndex].map((h: any) =>
    String(h)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  const findCol = (...patterns: string[][]): number => {
    for (const terms of patterns) {
      const idx = headerRow.findIndex((h) => terms.every((t) => h.includes(t)));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const snoColIndex = findCol(
    ["s no"],
    ["sno"],
    ["s n"],
    ["serial no"],
    ["serial"]
  );

  const colMap = {
    name: findCol(["student name"], ["full name"], ["name"]),
    email: findCol(["email address"], ["e mail"], ["email"]),
    password: findCol(["password"], ["pass"]),
    username: findCol(["username"], ["user name"], ["login id"], ["login"]),
    alternatePhone: findCol(
      ["alternate phone"],
      ["alt phone"],
      ["alternate mobile"],
      ["second phone"],
      ["other phone"],
      ["alternate contact"]
    ),
    phone: findCol(["phone"], ["mobile"], ["contact"]),
    dateOfBirth: findCol(
      ["date of birth"],
      ["dob"],
      ["birth date"],
      ["birthdate"]
    ),
    gender: findCol(["gender"], ["sex"]),
    bloodGroup: findCol(["blood group"], ["blood type"], ["blood"]),
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
    addressLineOne: findCol(
      ["address line 1"],
      ["address line one"],
      ["address1"],
      ["street address"]
    ),
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
    socialCategory: findCol(
      ["social category"],
      ["caste category"],
      ["category"]
    ),
    religion: findCol(["religion"]),
    pen: findCol(["pen"], ["permanent education number"], ["p e n"]),
    apaarId: findCol(["apaar id"], ["apaar"], ["abc id"]),
    stateStudentId: findCol(
      ["state student id"],
      ["state id"],
      ["samagra id"],
      ["udise student id"]
    ),
  };

  const missing: string[] = [];
  if (colMap.name === -1 || colMap.name === snoColIndex) missing.push("Name");
  if (colMap.password === -1 || colMap.password === snoColIndex)
    missing.push("Password");
  // NOTE: Email is no longer required — it is intentionally NOT included in
  // this required-column check. It's still detected by findCol() above (and
  // used by isHeaderRow() to locate the header row itself), but a school
  // with an Email column present-but-empty for every row is a valid file.
  if (missing.length > 0)
    throw new Error(
      `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(
        ", "
      )}. ` +
      "Please use the official student upload template and do not rename the column headers."
    );

  const rows: BulkStudentRow[] = [];
  for (let i = dataStartIndex; i < rawData.length; i++) {
    const row = rawData[i];
    const excelRowNumber = i + 1;
    const isEmptyRow = row.every(
      (cell: any) => !cell || String(cell).trim() === ""
    );
    if (isEmptyRow) continue;

    const str = (colIdx: number): string => {
      if (colIdx === -1 || colIdx === snoColIndex) return "";
      return String(row[colIdx] ?? "").trim();
    };

    // — same guard logic as str(), but routes through normaliseDateCell()
    // instead of a blind String() cast, so numeric/Date cell values are
    // converted to ISO date strings rather than stringified as-is.
    const dateColStr = (colIdx: number): string => {
      if (colIdx === -1 || colIdx === snoColIndex) return "";
      return normaliseDateCell(row[colIdx]);
    };

    const nameVal = str(colMap.name);
    const emailVal = str(colMap.email).toLowerCase();
    const passwordVal = str(colMap.password);
    const usernameVal = str(colMap.username);
    if (!nameVal && !emailVal && !passwordVal && !usernameVal) continue;

    rows.push({
      rowNumber: excelRowNumber,
      name: nameVal,
      email: emailVal || undefined, // optional — undefined when blank
      username: usernameVal ? normalizeUsername(usernameVal) : undefined,
      password: passwordVal,
      phone: str(colMap.phone) || undefined,
      alternatePhone: str(colMap.alternatePhone) || undefined,
      dateOfBirth: dateColStr(colMap.dateOfBirth) || undefined,
      gender: str(colMap.gender) || undefined,
      bloodGroup: str(colMap.bloodGroup) || undefined,
      fatherName: str(colMap.fatherName) || undefined,
      motherName: str(colMap.motherName) || undefined,
      guardianName: str(colMap.guardianName) || undefined,
      guardianRelation: str(colMap.guardianRelation) || undefined,
      addressLineOne: str(colMap.addressLineOne) || undefined,
      addressLineTwo: str(colMap.addressLineTwo) || undefined,
      city: str(colMap.city) || undefined,
      state: str(colMap.state) || undefined,
      postalCode: str(colMap.postalCode) || undefined,
      admissionNumber: str(colMap.admissionNumber) || undefined,
      admissionDate: dateColStr(colMap.admissionDate) || undefined,
      rollNumber: str(colMap.rollNumber) || undefined,
      previousSchool: str(colMap.previousSchool) || undefined,
      medicalInfo: str(colMap.medicalInfo) || undefined,
      enrollmentType: str(colMap.enrollmentType).toUpperCase() || undefined,
      previousClassResult:
        str(colMap.previousClassResult).toUpperCase() || undefined,
      previousSchoolUdiseCode: str(colMap.previousSchoolUdiseCode) || undefined,
      socialCategoryRaw: str(colMap.socialCategory) || undefined,
      religionRaw: str(colMap.religion) || undefined,
      pen: str(colMap.pen) || undefined,
      apaarId: str(colMap.apaarId) || undefined,
      stateStudentId: str(colMap.stateStudentId) || undefined,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATORS / HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function validateRow(row: BulkStudentRow): string | null {
  if (!row.name || row.name.length < 2)
    return "Name must be at least 2 characters";
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
    return "Invalid email address";
  if (!row.password || row.password.length < 8)
    return "Password must be at least 8 characters";
  if (row.username && !isValidUsernameFormat(row.username))
    return (
      `Invalid username "${row.username}". Must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} ` +
      "characters, start with a letter, and contain only lowercase letters and numbers."
    );
  if (row.gender && !GENDER_NORMALIZER[row.gender.toLowerCase()])
    return `Invalid gender "${row.gender}". Use: Male, Female, or Transgender`;
  if (
    row.bloodGroup &&
    !VALID_BLOOD_GROUPS.has(row.bloodGroup.toUpperCase().replace(/\s/g, ""))
  )
    return `Invalid blood group "${row.bloodGroup}". Allowed: A+, A-, B+, B-, AB+, AB-, O+, O-`;
  if (row.enrollmentType && !VALID_ENROLLMENT_TYPES.has(row.enrollmentType))
    return `Invalid enrollment type "${row.enrollmentType}". Use: REGULAR, PRIVATE, or OPEN_SCHOOL`;
  if (
    row.previousClassResult &&
    !VALID_PREVIOUS_CLASS_RESULTS.has(row.previousClassResult)
  )
    return `Invalid previous class result "${row.previousClassResult}". Use: PROMOTED, NOT_PROMOTED, NEW_ADMISSION, or TRANSFERRED`;
  if (
    row.socialCategoryRaw &&
    resolveSocialCategory(row.socialCategoryRaw) === null
  )
    return `Invalid social category "${row.socialCategoryRaw}". Use 1–5 or: General, SC, ST, OBC, OBC-NCL`;
  if (row.religionRaw && resolveReligion(row.religionRaw) === null)
    return `Invalid religion "${row.religionRaw}". Use 1–8 or: Hindu, Muslim, Christian, Sikh, Buddhist, Jain, Others, No Religion`;
  return null;
}

function collectUDISEWarnings(row: BulkStudentRow): UDISEWarning[] {
  const warnings: UDISEWarning[] = [];
  if (row.pen && !isValidPEN(row.pen))
    warnings.push({
      rowNumber: row.rowNumber,
      field: "pen",
      value: row.pen,
      message: `PEN "${row.pen}" is not a valid 16-digit number. It will be stored as-is for manual correction.`,
    });
  if (row.apaarId && !isValidAPAAR(row.apaarId))
    warnings.push({
      rowNumber: row.rowNumber,
      field: "apaarId",
      value: row.apaarId,
      message: `APAAR ID "${row.apaarId}" is not a valid 12-digit number. It will be stored as-is for manual correction.`,
    });
  if (
    row.previousSchoolUdiseCode &&
    !isValidUDISECode(row.previousSchoolUdiseCode)
  )
    warnings.push({
      rowNumber: row.rowNumber,
      field: "previousSchoolUdiseCode",
      value: row.previousSchoolUdiseCode,
      message: `Previous school UDISE code "${row.previousSchoolUdiseCode}" is not a valid 11-digit code. It will be stored as-is for manual correction.`,
    });
  return warnings;
}

function resolveSocialCategory(raw: string): number | null {
  const n = raw.toLowerCase().trim();
  return SOCIAL_CATEGORY_MAP[n] ?? SOCIAL_CATEGORY_MAP[raw.trim()] ?? null;
}

function resolveReligion(raw: string): number | null {
  const n = raw.toLowerCase().trim();
  return RELIGION_MAP[n] ?? RELIGION_MAP[raw.trim()] ?? null;
}

function normaliseGender(raw: string | undefined): string {
  if (!raw) return "";
  return GENDER_NORMALIZER[raw.toLowerCase().trim()] ?? "";
}

function normaliseBloodGroup(raw: string | undefined): string {
  if (!raw) return "";
  return raw.toUpperCase().replace(/\s/g, "");
}

/**
 * Normalizes a raw Excel cell value for a date column (DOB, Admission Date)
 * into a clean "YYYY-MM-DD" string, regardless of how Excel stored it:
 *   • Date object    — when { cellDates: true } auto-detected a date-formatted cell
 *   • number         — a raw Excel serial slipped through (old template, no
 *                       explicit Text format, or a paste that re-triggered
 *                       Excel's auto-date-detection)
 *   • string         — the expected case (Text-formatted cell, e.g. "2009-07-18"),
 *                       but also guards against a serial that arrived as text
 *                       (e.g. "40012") from a raw CSV or other odd source
 */
function normaliseDateCell(raw: any): string {
  if (raw === undefined || raw === null || raw === "") return "";

  // Case 1: xlsx already parsed it into a real Date (cellDates: true)
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }

  // Case 2: raw Excel serial number (days since 1899-12-30)
  if (typeof raw === "number" && isFinite(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  // Case 3: a serial number that arrived as a plain string, e.g. "40012"
  if (/^\d{4,6}(\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    // Sanity range: Excel dates from ~1950 to ~2100 fall roughly between
    // 18000–73000 — guards against misreading a genuinely numeric non-date
    // value (unlikely here, but cheap to check) as a date.
    if (serial > 15000 && serial < 75000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
  }

  // Case 4: already a normal date string (expected case, e.g. "2009-07-18")
  // — return as-is; validateRow()/downstream DB layer handles format checks.
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK USERNAME GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips a string to lowercase ASCII alphanumerics only. Unlike
 * buildUsernameBase(), this does NOT strip leading digits — it's used for
 * the class/section segments of a bulk username, which are never the first
 * character of the final string, so a leading digit there (e.g. class "2")
 * is perfectly fine and exactly what produces the "amit2a" pattern.
 */
function asciiAlnumSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Builds a human-recognizable username base for a bulk-uploaded student:
 * firstName + className + sectionName, e.g. "Amit Sharma" in Class 2 /
 * Section A → "amit2a". Deliberately different from the single-user-create
 * path's name+random-suffix pattern — bulk uploads benefit from a readable,
 * predictable convention the admin can anticipate across a whole class list.
 *
 * The name segment goes through buildUsernameBase() (which guarantees the
 * result starts with a letter and is never empty), so the combined string
 * always satisfies the "must start with a letter" rule regardless of what
 * className/sectionName contribute.
 */
function buildBulkStudentUsernameBase(
  name: string,
  className: string,
  sectionName: string
): string {
  const firstWord = name.trim().split(/\s+/)[0] ?? "";
  const namePart = buildUsernameBase(firstWord || name, 14);
  const classPart = asciiAlnumSlug(className).slice(0, 8);
  const sectionPart = asciiAlnumSlug(sectionName).slice(0, 4);

  let combined = `${namePart}${classPart}${sectionPart}`;
  if (combined.length < USERNAME_MIN_LENGTH) {
    // Pathological edge case — e.g. a class/section named entirely in a
    // script with no ASCII letters/digits. Pad rather than fail; digits at
    // the END are fine format-wise (only a LEADING digit is disallowed).
    combined = combined.padEnd(USERNAME_MIN_LENGTH, "0");
  }
  // Leave headroom for up to a 6-char random suffix if a collision forces
  // regeneration, so the final candidate never exceeds USERNAME_MAX_LENGTH.
  return combined.slice(0, USERNAME_MAX_LENGTH - 6);
}

interface UsernameRowState {
  row: BulkStudentRow;
  isExplicit: boolean;
  base: string;
  candidate: string;
  finalized: boolean;
}

/**
 * Resolves a unique username for every row in ONE pass across at most a
 * few DB round trips total (not per-row):
 *
 *   Round 0: candidates are checked against a set the CALLER already fetched
 *            as part of the SAME db.batch() call that also fetches capacity
 *            + existing emails — zero extra round trips for the common,
 *            no-collision case.
 *   Round 1+: only entered if round 0 found collisions (in-file duplicates
 *            like two "Amit"s in 2A, or a name+class+section combo that
 *            happens to already exist) — one extra SELECT per round,
 *            checking only the handful of regenerated candidates, not the
 *            whole batch.
 *
 * Explicit (admin-typed) usernames that collide are NOT auto-regenerated —
 * they're collected as blocking conflicts, mirroring how email conflicts
 * already halt the whole upload. Only auto-generated candidates get the
 * retry-with-random-suffix treatment.
 */
async function resolveBulkUsernames(
  db: any,
  rows: BulkStudentRow[],
  className: string,
  sectionName: string,
  round0ExistingUsernames: Set<string>
): Promise<{
  finalUsernameByRow: Map<number, string>;
  usernameConflicts: UsernameConflict[];
}> {
  const states: UsernameRowState[] = rows.map((row) => {
    if (row.username) {
      return {
        row,
        isExplicit: true,
        base: row.username,
        candidate: row.username,
        finalized: false,
      };
    }
    const base = buildBulkStudentUsernameBase(row.name, className, sectionName);
    return { row, isExplicit: false, base, candidate: base, finalized: false };
  });

  const usernameConflicts: UsernameConflict[] = [];
  const MAX_ROUNDS = 5;
  let round = 0;

  while (round < MAX_ROUNDS) {
    const unresolved = states.filter((s) => !s.finalized);
    if (unresolved.length === 0) break;

    const claimed = new Map<string, UsernameRowState>();
    states.filter((s) => s.finalized).forEach((s) => claimed.set(s.candidate, s));

    let dbConflictSet: Set<string>;
    if (round === 0) {
      dbConflictSet = round0ExistingUsernames;
    } else {
      const toCheck = [...new Set(unresolved.map((s) => s.candidate))];
      const dbRows = await db
        .select({ username: schoolUsersSchema.username })
        .from(schoolUsersSchema)
        .where(
          inArray(schoolUsersSchema.username, toCheck.length > 0 ? toCheck : ["__none__"])
        )
        .all();
      dbConflictSet = new Set(dbRows.map((r: any) => r.username));
    }

    for (const state of unresolved) {
      const inDb = dbConflictSet.has(state.candidate);
      const inBatch = claimed.has(state.candidate);

      if (!inDb && !inBatch) {
        state.finalized = true;
        claimed.set(state.candidate, state);
        continue;
      }

      if (state.isExplicit) {
        usernameConflicts.push({
          rowNumber: state.row.rowNumber,
          name: state.row.name,
          username: state.candidate,
          conflictType: inDb ? "ALREADY_IN_SCHOOL" : "DUPLICATE_IN_FILE",
        });
        state.finalized = true; // don't retry — this is a blocking error
        continue;
      }

      // Auto-generated: draw a fresh random suffix and retry next round.
      const suffixLength = round < 2 ? 4 : 6;
      state.candidate = `${state.base}${randomUsernameSuffix(suffixLength)}`.slice(
        0,
        USERNAME_MAX_LENGTH
      );
    }

    round++;
  }

  const stillUnresolved = states.filter((s) => !s.finalized);
  if (stillUnresolved.length > 0) {
    // Astronomically unlikely (would need repeated collisions across every
    // round for the same row) — log and let it through with its last
    // candidate. If it does somehow collide at insert time, the existing
    // batch-insert-then-sequential-fallback safety net catches it as an
    // ordinary per-row failure (see the sequential fallback branch below).
    console.warn(
      `[bulk-upload] ${stillUnresolved.length} row(s) could not get a confirmed-unique username after ${MAX_ROUNDS} rounds — proceeding with best-effort candidates.`
    );
  }

  const finalUsernameByRow = new Map<number, string>(
    states.map((s) => [s.row.rowNumber, s.candidate])
  );

  return { finalUsernameByRow, usernameConflicts };
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

  const [classSection, currentYear] = await Promise.all([
    db
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
      .get(),
    db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get(),
  ]);

  if (!classSection) throw new Error("Class-section not found");

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

  return {
    classSectionId,
    className: classSection.className,
    sectionName: classSection.sectionName,
    existingStudents,
    maxAllowed: classSection.capacity,
    remaining: Math.max(0, classSection.capacity - existingStudents),
    canAddMore: classSection.capacity - existingStudents > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WELCOME EMAIL BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildWelcomeEmail(
  row: BulkStudentRow,
  username: string,
  className: string,
  sectionName: string,
  schoolCode: string
) {
  return {
    subject: `Welcome to ${schoolCode} School Portal`,
    htmlContent: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;">
        <h2 style="color:#1e293b;margin:0 0 8px">Welcome, ${row.name}!</h2>
        <p style="color:#475569;margin:0 0 20px">
          Your student account has been created for
          <strong>${className} – ${sectionName}</strong>.
        </p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin:0 0 20px">
          <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Username</p>
          <p style="margin:0 0 16px;color:#1e293b;font-weight:600;font-size:15px">${username}</p>
          ${row.email
        ? `
          <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Login Email</p>
          <p style="margin:0 0 16px;color:#1e293b;font-weight:600;font-size:15px">${row.email}</p>
          `
        : ""
      }
          <p style="margin:0 0 4px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Temporary Password</p>
          <p style="margin:0;color:#1e293b;font-weight:600;font-size:15px">${row.password}</p>
        </div>
        <p style="color:#f59e0b;font-size:13px;margin:0">
          ⚠️ Please change your password after your first login. You can log in with either your username or email.
        </p>
      </div>
    `,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVED ROW TYPE
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedStudentData {
  row: BulkStudentRow;
  passwordHash: string;
  username: string;
  genderValue: string;
  bloodGroupValue: string;
  socialCategory: number | null;
  religion: number | null;
  udiseWarnings: UDISEWarning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

async function resolveAllRows(
  validRows: BulkStudentRow[],
  usernameByRow: Map<number, string>
): Promise<ResolvedStudentData[]> {
  return Promise.all(
    validRows.map(async (row) => {
      const passwordHash = await hashPasswordFast(row.password);
      return {
        row,
        passwordHash,
        username: usernameByRow.get(row.rowNumber)!,
        genderValue: normaliseGender(row.gender),
        bloodGroupValue: normaliseBloodGroup(row.bloodGroup),
        socialCategory: row.socialCategoryRaw
          ? resolveSocialCategory(row.socialCategoryRaw)
          : null,
        religion: row.religionRaw ? resolveReligion(row.religionRaw) : null,
        udiseWarnings: collectUDISEWarnings(row),
      };
    })
  );
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

  // ── 1. Parse Excel ──────────────────────────────────────────────────────────
  let rows: BulkStudentRow[];
  try {
    rows = await parseExcelBuffer(input.fileBuffer);
  } catch (err: any) {
    return errorResult(`Failed to parse Excel file: ${err.message}`);
  }

  if (rows.length === 0)
    return errorResult("No data rows found in the Excel file");

  // ── 2. Setup — one db.batch() round-trip ────────────────────────────────────
  const setupBatch = await db.batch([
    db
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
      .where(eq(schoolClassSectionsSchema.id, input.classSectionId)),
    db
      .select({ id: schoolAcademicYearsSchema.id })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true)),
    db
      .select({ id: schoolRolesSchema.id })
      .from(schoolRolesSchema)
      .where(eq(schoolRolesSchema.name, SchoolRole.STUDENT)),
  ] as const);

  const classSection = setupBatch[0][0];
  const resolvedYear = input.academicYearId
    ? { id: input.academicYearId }
    : setupBatch[1][0];
  const studentRole = setupBatch[2][0];

  if (!classSection) return errorResult("Class-section not found", rows.length);
  if (!classSection.isActive)
    return errorResult(
      `Class-section ${classSection.className} – ${classSection.sectionName} is inactive`,
      rows.length
    );
  if (!resolvedYear)
    return errorResult(
      "No current academic year found. Please set a current academic year first.",
      rows.length
    );
  if (!studentRole)
    return errorResult(
      "STUDENT role not found in this school. Please contact support.",
      rows.length
    );

  const resolvedAcademicYearId = resolvedYear.id;
  const maxAllowed = classSection.capacity;

  // ── 2.5. Build round-0 username candidates BEFORE the batch call, so the
  //    DB check can be folded into the SAME round trip as capacity+email
  //    (zero extra subrequests in the common, no-collision case). ────────────
  const round0Candidates = [
    ...new Set(
      rows.map((row) =>
        row.username
          ? row.username
          : buildBulkStudentUsernameBase(
            row.name,
            classSection.className,
            classSection.sectionName
          )
      )
    ),
  ];

  // ── 3. Capacity + email conflict + username round-0 — ONE batch round-trip ─
  const allEmails = rows.filter((r) => r.email).map((r) => r.email!.toLowerCase());

  const [countResult, existingUsersResult, existingUsernamesResult] = await db.batch([
    db
      .select({ count: sql<number>`count(*)` })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(
            schoolStudentEnrollmentsSchema.classSectionId,
            input.classSectionId
          ),
          eq(
            schoolStudentEnrollmentsSchema.academicYearId,
            resolvedAcademicYearId
          ),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      ),
    db
      .select({ email: schoolUsersSchema.email })
      .from(schoolUsersSchema)
      .where(
        inArray(
          schoolUsersSchema.email,
          allEmails.length > 0 ? allEmails : ["__none__"]
        )
      ),
    db
      .select({ username: schoolUsersSchema.username })
      .from(schoolUsersSchema)
      .where(
        inArray(
          schoolUsersSchema.username,
          round0Candidates.length > 0 ? round0Candidates : ["__none__"]
        )
      ),
  ] as const);

  const existingStudents = (countResult[0]?.count ?? 0) as number;
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
      message: `Cannot add ${rows.length
        } students. Only ${availableSlots} slot${availableSlots !== 1 ? "s" : ""
        } available in ${classSection.className} – ${classSection.sectionName
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

  // ── 4. Resolve final usernames — round 0 result feeds in from the batch
  //    above; further rounds only run if collisions were actually found ──────
  const existingUsernameSet = new Set(
    existingUsernamesResult.map((u: any) => u.username)
  );
  const { finalUsernameByRow, usernameConflicts } = await resolveBulkUsernames(
    db,
    rows,
    classSection.className,
    classSection.sectionName,
    existingUsernameSet
  );

  // ── 5. Email conflict detection — only rows that actually have an email ────
  const emailConflicts: EmailConflict[] = [];
  const seenEmails = new Map<string, number>();

  for (const row of rows) {
    if (!row.email) continue;
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

  const existingEmailSet = new Set(
    existingUsersResult
      .map((u: any) => u.email?.toLowerCase())
      .filter(Boolean)
  );
  for (const row of rows) {
    if (!row.email) continue;
    if (
      existingEmailSet.has(row.email.toLowerCase()) &&
      !emailConflicts.some((c) => c.rowNumber === row.rowNumber)
    ) {
      emailConflicts.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email,
        conflictType: "ALREADY_IN_SCHOOL",
      });
    }
  }

  // ── 6. Combined blocking response — email OR username conflicts ────────────
  if (emailConflicts.length > 0 || usernameConflicts.length > 0) {
    const parts: string[] = [];

    if (emailConflicts.length > 0) {
      const inFileCount = emailConflicts.filter(
        (c) => c.conflictType === "DUPLICATE_IN_FILE"
      ).length;
      const inSchoolCount = emailConflicts.filter(
        (c) => c.conflictType === "ALREADY_IN_SCHOOL"
      ).length;
      if (inSchoolCount > 0)
        parts.push(
          `${inSchoolCount} email${inSchoolCount !== 1 ? "s are" : " is"
          } already registered in this school`
        );
      if (inFileCount > 0)
        parts.push(
          `${inFileCount} duplicate email${inFileCount !== 1 ? "s" : ""
          } within the file`
        );
    }

    if (usernameConflicts.length > 0) {
      const inFileCount = usernameConflicts.filter(
        (c) => c.conflictType === "DUPLICATE_IN_FILE"
      ).length;
      const inSchoolCount = usernameConflicts.filter(
        (c) => c.conflictType === "ALREADY_IN_SCHOOL"
      ).length;
      if (inSchoolCount > 0)
        parts.push(
          `${inSchoolCount} username${inSchoolCount !== 1 ? "s are" : " is"
          } already taken in this school`
        );
      if (inFileCount > 0)
        parts.push(
          `${inFileCount} duplicate username${inFileCount !== 1 ? "s" : ""
          } within the file`
        );
    }

    return {
      success: false,
      message: `Upload blocked: ${parts.join(
        " and "
      )}. No students were added. Please fix the issues and re-upload.`,
      summary: {
        totalRows: rows.length,
        successful: 0,
        failed: emailConflicts.length + usernameConflicts.length,
        skipped: 0,
        udiseWarnings: 0,
      },
      results: [],
      emailConflicts: emailConflicts.length > 0 ? emailConflicts : undefined,
      usernameConflicts:
        usernameConflicts.length > 0 ? usernameConflicts : undefined,
    };
  }

  // ── 7. Per-row validation ───────────────────────────────────────────────────
  const rowResults: BulkUploadRowResult[] = [];
  const validRows: BulkStudentRow[] = [];

  for (const row of rows) {
    const err = validateRow(row);
    if (err) {
      rowResults.push({
        rowNumber: row.rowNumber,
        name: row.name,
        email: row.email ?? "",
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

  // ── 8. Parallel PBKDF2 hashing + username attachment ────────────────────────
  const resolved = await resolveAllRows(validRows, finalUsernameByRow);

  // ── 9. Build insert payloads ────────────────────────────────────────────────
  const userValues = resolved.map((r) => ({
    name: r.row.name,
    username: r.username,
    email: r.row.email || null,
    passwordHash: r.passwordHash,
    primaryRole: SchoolRole.STUDENT,
    phone: r.row.phone || "",
    alternatePhone: r.row.alternatePhone || "",
    dateOfBirth: r.row.dateOfBirth || "",
    gender: r.genderValue as any,
    bloodGroup: r.bloodGroupValue,
    avatarUrl: "",
    fatherName: r.row.fatherName || "",
    motherName: r.row.motherName || "",
    guardianName: r.row.guardianName || "",
    guardianRelation: r.row.guardianRelation || "",
    addressLineOne: r.row.addressLineOne || "",
    addressLineTwo: r.row.addressLineTwo || "",
    city: r.row.city || "",
    state: r.row.state || "",
    postalCode: r.row.postalCode || "",
    tokenVersion: 0,
    isActive: true,
  }));

  // ── 10. Batch insert ─────────────────────────────────────────────────────────
  const insertedUserIds: number[] = [];

  try {
    // Batch A: users with .returning() to get IDs
    const newUsers = await db
      .insert(schoolUsersSchema)
      .values(userValues)
      .returning({ id: schoolUsersSchema.id });

    newUsers.forEach((u, idx) => {
      insertedUserIds[idx] = u.id;
    });

    // Batch B: roles + student profiles + enrollments — one round-trip
    await db.batch([
      db
        .insert(schoolUserRolesSchema)
        .values(
          newUsers.map((u) => ({ userId: u.id, roleId: studentRole.id }))
        ),
      db.insert(studentsSchema).values(
        resolved.map((r, idx) => ({
          userId: newUsers[idx].id,
          admissionNumber: r.row.admissionNumber || null,
          admissionDate: r.row.admissionDate || "",
          rollNumber: r.row.rollNumber || "",
          previousSchool: r.row.previousSchool || "",
          medicalInfo: r.row.medicalInfo || "",
          enrollmentType: (r.row.enrollmentType &&
            VALID_ENROLLMENT_TYPES.has(r.row.enrollmentType)
            ? r.row.enrollmentType
            : "REGULAR") as any,
          previousClassResult: (r.row.previousClassResult || null) as any,
          previousSchoolUdiseCode: r.row.previousSchoolUdiseCode || null,
          socialCategory: (r.socialCategory ?? null) as any,
          religion: (r.religion ?? null) as any,
          pen: r.row.pen || null,
          apaarId: r.row.apaarId || null,
          stateStudentId: r.row.stateStudentId || null,
          isAadhaarVerified: false,
          udiseVerified: false,
          isMinority: false,
          isBpl: false,
          isCwsn: false,
          hasDisabilityCertificate: false,
          facilitiesReceived: "[]",
        }))
      ),
      db.insert(schoolStudentEnrollmentsSchema).values(
        newUsers.map((u) => ({
          studentId: u.id,
          academicYearId: resolvedAcademicYearId,
          classSectionId: input.classSectionId,
          isActive: true,
        }))
      ),
    ] as const);

    resolved.forEach((r, idx) => {
      rowResults.push({
        rowNumber: r.row.rowNumber,
        name: r.row.name,
        email: r.row.email ?? "",
        username: r.username,
        status: "SUCCESS",
        userId: insertedUserIds[idx],
        udiseWarnings: r.udiseWarnings.length > 0 ? r.udiseWarnings : undefined,
      });
    });
  } catch (batchErr: any) {
    console.warn(
      `[bulk-upload] Batch insert failed (${batchErr.message}). Falling back to sequential inserts.`
    );

    for (const r of resolved) {
      try {
        const [newUser] = await db
          .insert(schoolUsersSchema)
          .values({
            name: r.row.name,
            username: r.username,
            email: r.row.email || null,
            passwordHash: r.passwordHash,
            primaryRole: SchoolRole.STUDENT,
            phone: r.row.phone || "",
            alternatePhone: r.row.alternatePhone || "",
            dateOfBirth: r.row.dateOfBirth || "",
            gender: r.genderValue as any,
            bloodGroup: r.bloodGroupValue,
            avatarUrl: "",
            fatherName: r.row.fatherName || "",
            motherName: r.row.motherName || "",
            guardianName: r.row.guardianName || "",
            guardianRelation: r.row.guardianRelation || "",
            addressLineOne: r.row.addressLineOne || "",
            addressLineTwo: r.row.addressLineTwo || "",
            city: r.row.city || "",
            state: r.row.state || "",
            postalCode: r.row.postalCode || "",
            tokenVersion: 0,
            isActive: true,
          })
          .returning({ id: schoolUsersSchema.id });

        await db.batch([
          db
            .insert(schoolUserRolesSchema)
            .values({ userId: newUser.id, roleId: studentRole.id }),
          db.insert(studentsSchema).values({
            userId: newUser.id,
            admissionNumber: r.row.admissionNumber || null,
            admissionDate: r.row.admissionDate || "",
            rollNumber: r.row.rollNumber || "",
            previousSchool: r.row.previousSchool || "",
            medicalInfo: r.row.medicalInfo || "",
            enrollmentType: (r.row.enrollmentType &&
              VALID_ENROLLMENT_TYPES.has(r.row.enrollmentType)
              ? r.row.enrollmentType
              : "REGULAR") as any,
            previousClassResult: (r.row.previousClassResult || null) as any,
            previousSchoolUdiseCode: r.row.previousSchoolUdiseCode || null,
            socialCategory: (r.socialCategory ?? null) as any,
            religion: (r.religion ?? null) as any,
            pen: r.row.pen || null,
            apaarId: r.row.apaarId || null,
            stateStudentId: r.row.stateStudentId || null,
            isAadhaarVerified: false,
            udiseVerified: false,
            isMinority: false,
            isBpl: false,
            isCwsn: false,
            hasDisabilityCertificate: false,
            facilitiesReceived: "[]",
          }),
          db.insert(schoolStudentEnrollmentsSchema).values({
            studentId: newUser.id,
            academicYearId: resolvedAcademicYearId,
            classSectionId: input.classSectionId,
            isActive: true,
          }),
        ] as const);

        rowResults.push({
          rowNumber: r.row.rowNumber,
          name: r.row.name,
          email: r.row.email ?? "",
          username: r.username,
          status: "SUCCESS",
          userId: newUser.id,
          udiseWarnings:
            r.udiseWarnings.length > 0 ? r.udiseWarnings : undefined,
        });
      } catch (rowErr: any) {
        console.error(
          `[bulk-upload] Row ${r.row.rowNumber} (${r.username}) failed:`,
          rowErr
        );
        const isUsernameCollision = isUniqueConstraintError(rowErr, "username");
        const isEmailCollision = isUniqueConstraintError(rowErr, "email");
        rowResults.push({
          rowNumber: r.row.rowNumber,
          name: r.row.name,
          email: r.row.email ?? "",
          status: "FAILED",
          error: isUsernameCollision
            ? `Username "${r.username}" was taken by another request during upload. Please retry this row.`
            : isEmailCollision
              ? "This email was registered by another request during upload. Please retry this row."
              : rowErr.message || "Unknown error during processing",
        });
      }
    }
  }

  // ── 11. Fire-and-forget welcome emails — only for rows that have an email ──
  const successResults = rowResults.filter((r) => r.status === "SUCCESS");
  const resolvedByRow = new Map(resolved.map((r) => [r.row.rowNumber, r]));

  Promise.allSettled(
    successResults.map((result) => {
      const r = resolvedByRow.get(result.rowNumber);
      if (!r || !r.row.email) return Promise.resolve(); // no email — nothing to send
      const { subject, htmlContent } = buildWelcomeEmail(
        r.row,
        r.username,
        classSection.className,
        classSection.sectionName,
        schoolCode
      );
      return sendTransactionalEmail(env, {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: r.row.email, name: r.row.name }],
        subject,
        htmlContent,
      }).catch((err) =>
        console.error(`Welcome email failed for row ${r.row.rowNumber}:`, err)
      );
    })
  );

  // ── 12. Final response ──────────────────────────────────────────────────────
  rowResults.sort((a, b) => a.rowNumber - b.rowNumber);

  const successCount = rowResults.filter((r) => r.status === "SUCCESS").length;
  const failCount = rowResults.filter((r) => r.status === "FAILED").length;
  const udiseWarningCount = rowResults.filter(
    (r) =>
      r.status === "SUCCESS" && r.udiseWarnings && r.udiseWarnings.length > 0
  ).length;

  const allSuccess = successCount === rows.length;
  const partialSuccess = successCount > 0 && failCount > 0;

  let message: string;
  if (allSuccess) {
    message = `Successfully added ${successCount} student${successCount !== 1 ? "s" : ""
      } to ${classSection.className} – ${classSection.sectionName}.`;
    if (udiseWarningCount > 0)
      message += ` Note: ${udiseWarningCount} student${udiseWarningCount !== 1 ? "s have" : " has"
        } UDISE field format issues — please review and correct from the student profile.`;
  } else if (partialSuccess) {
    message = `Partially completed: ${successCount} student${successCount !== 1 ? "s" : ""
      } added, ${failCount} failed.`;
    if (udiseWarningCount > 0)
      message += ` ${udiseWarningCount} student${udiseWarningCount !== 1 ? "s" : ""
        } added with UDISE format warnings.`;
  } else {
    message = `Upload failed: all ${failCount} rows had errors.`;
  }

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
      addedStudents: successCount,
      totalAfter: existingStudents + successCount,
      maxAllowed,
      remaining: Math.max(0, availableSlots - successCount),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────

function errorResult(message: string, totalRows = 0): BulkUploadResult {
  return {
    success: false,
    message,
    summary: {
      totalRows,
      successful: 0,
      failed: totalRows,
      skipped: 0,
      udiseWarnings: 0,
    },
    results: [],
  };
}