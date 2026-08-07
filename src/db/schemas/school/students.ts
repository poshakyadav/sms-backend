import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

// ─────────────────────────────────────────────────────────────────────────────
// UDISE+ ENUM CONSTANTS
// Using integer codes because UDISE+ Excel templates use numeric codes directly.
// Storing as integers means your export route maps column → value with zero
// transformation. Comments show the UDISE+ code book values.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SOCIAL CATEGORY CODES (UDISE+ code book)
 * Col: "Social Category" in UDISE+ Excel
 */
export const SocialCategory = {
  GENERAL: 1, // General / Unreserved
  SC: 2, // Scheduled Caste
  ST: 3, // Scheduled Tribe
  OBC: 4, // Other Backward Class
  OBC_NCL: 5, // OBC – Non Creamy Layer (some state variants)
  MINORITY: 6, // Minority community (state-variant UDISE+ category, distinct from religious minority flag)
} as const;
export type SocialCategoryValue =
  (typeof SocialCategory)[keyof typeof SocialCategory];

/**
 * RELIGION CODES (UDISE+ code book)
 * Col: "Religion" in UDISE+ Excel
 */
export const Religion = {
  HINDU: 1,
  MUSLIM: 2,
  CHRISTIAN: 3,
  SIKH: 4,
  BUDDHIST: 5,
  JAIN: 6,
  OTHERS: 7,
  NO_RELIGION: 8,
} as const;
export type ReligionValue = (typeof Religion)[keyof typeof Religion];

/**
 * ENROLLMENT TYPE CODES (UDISE+ code book)
 */
export const EnrollmentType = {
  REGULAR: "REGULAR", // Regular school student
  PRIVATE: "PRIVATE", // Private candidate (not attending school)
  OPEN_SCHOOL: "OPEN_SCHOOL", // NIOS / open school registration
} as const;
export type EnrollmentTypeValue =
  (typeof EnrollmentType)[keyof typeof EnrollmentType];

/**
 * PREVIOUS CLASS RESULT CODES (UDISE+ code book)
 * Required for new admissions: how did the student exit their previous class?
 */
export const PreviousClassResult = {
  PROMOTED: "PROMOTED", // Passed and promoted to next class
  NOT_PROMOTED: "NOT_PROMOTED", // Failed / detained in same class
  NEW_ADMISSION: "NEW_ADMISSION", // First-time entry (Nursery / Class 1 new students)
  TRANSFERRED: "TRANSFERRED", // TC from another school mid-year
} as const;
export type PreviousClassResultValue =
  (typeof PreviousClassResult)[keyof typeof PreviousClassResult];

/**
 * LOCALITY TYPE (UDISE+ code book)
 * Determines whether the student's residence is urban or rural.
 * Used for geographic and demographic reporting.
 */
export const LocalityType = {
  URBAN: "URBAN",
  RURAL: "RURAL",
} as const;
export type LocalityTypeValue =
  (typeof LocalityType)[keyof typeof LocalityType];

/**
 * DISABILITY TYPE CODES (UDISE+ code book — CWSN section)
 * Only populated when isCwsn = true.
 */
export const DisabilityType = {
  VISUAL_IMPAIRMENT: 1,
  HEARING_IMPAIRMENT: 2,
  SPEECH_AND_LANGUAGE: 3,
  LOCOMOTOR_DISABILITY: 4,
  MENTAL_RETARDATION: 5,
  LEARNING_DISABILITY: 6,
  AUTISM: 7,
  MULTIPLE_DISABILITIES: 8,
  OTHERS: 9,
} as const;
export type DisabilityTypeValue =
  (typeof DisabilityType)[keyof typeof DisabilityType];

/**
 * FACILITIES RECEIVED (UDISE+ code book)
 * Stored as a JSON array of these string codes.
 * e.g., ["FREE_TEXTBOOKS", "FREE_UNIFORM"]
 */
export const FacilityReceived = {
  FREE_TEXTBOOKS: "FREE_TEXTBOOKS",
  FREE_UNIFORM: "FREE_UNIFORM",
  FREE_TRANSPORT: "FREE_TRANSPORT",
  FREE_BICYCLE: "FREE_BICYCLE",
  SCHOLARSHIP: "SCHOLARSHIP",
  MID_DAY_MEAL: "MID_DAY_MEAL",
  FREE_STATIONERY: "FREE_STATIONERY",
  OTHERS: "OTHERS",
} as const;
export type FacilityReceivedValue =
  (typeof FacilityReceived)[keyof typeof FacilityReceived];

// ─────────────────────────────────────────────────────────────────────────────
// STUDENTS TABLE
// ─────────────────────────────────────────────────────────────────────────────

export const studentsSchema = sqliteTable("students", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  // ── SCHOOL INTERNAL RECORDS ───────────────────────────────────────────────

  /**
   * School's own admission/registration number.
   * Unique per school. Printed on TC, fee receipts, admit cards.
   * UDISE+ includes this in the student record export.
   */
  /**
     * School's own admission/registration number.
     * Unique per school — enforced by idx_students_admission_number_unique
     * below AND by an app-level pre-check in services.ts (see
     * createSchoolUser / updateSchoolUser / bulkUploadStudents).
     * NULL is allowed and multiple NULLs do not conflict (SQLite treats
     * every NULL as distinct under a UNIQUE index).
     */
  admissionNumber: text("admission_number"), // unique per school, enforced in code

  /**
   * Date of admission to THIS school.
   * Format: "YYYY-MM-DD". Required for TC generation and UDISE+ enrollment data.
   */
  admissionDate: text("admission_date"),

  /**
   * General roll number — school's internal identifier within a class.
   * Distinct from the enrollment-level rollNumber (which is per academic year).
   * Some schools have a permanent roll number that doesn't change year to year.
   */
  rollNumber: text("roll_number"),

  /**
   * Enrollment type as per UDISE+ classification.
   * Most students are REGULAR. Private/Open School candidates are edge cases.
   */
  enrollmentType: text("enrollment_type")
    .$type<EnrollmentTypeValue>()
    .default("REGULAR")
    .notNull(),

  // ── PREVIOUS SCHOOL / TRANSFER DETAILS ───────────────────────────────────

  /**
   * Name of the student's previous school (free text).
   * Used for TC, new admission forms, and historical records.
   */
  previousSchool: text("previous_school"),

  /**
   * UDISE code of the previous school (11 digits).
   * Required by UDISE+ when a student transfers from another school.
   * Enables the government to track student movement across schools.
   * NULL for new first-time admissions (Nursery / Class 1).
   */
  previousSchoolUdiseCode: text("previous_school_udise_code"), // 11-digit UDISE code

  /**
   * Result/status in the student's last class at their previous school.
   * UDISE+ requires this to understand whether the student was promoted,
   * detained, or is a completely new entrant to the education system.
   */
  previousClassResult: text(
    "previous_class_result"
  ).$type<PreviousClassResultValue>(),

  // ── UDISE / NATIONAL IDENTITY FIELDS ─────────────────────────────────────

  /**
   * Permanent Education Number — assigned by UDISE+ to every student.
   * Format: 16-digit numeric string. Unique across India.
   * Collected from the student's previous school TC or from UDISE+ portal.
   * NULL = not yet collected (most students will start without it).
   */
  pen: text("pen"), // Permanent Education Number — 16 digits

  /**
   * APAAR ID (Academic Bank of Credits ID / ABC ID).
   * Generated via UDISE+ or DigiLocker. 12-digit numeric string.
   * Part of NEP 2020 implementation. Linked to student's Aadhaar.
   * Required progressively from 2024-25 academic year onwards.
   */
  apaarId: text("apaar_id"), // APAAR/ABC ID — 12 digits

  /**
   * State-level student tracking ID.
   * Every state has their own student ID system (e.g. SAMAGRA ID in MP,
   * U-DISE Student ID in UP, etc.). Nullable — only relevant in states
   * that have implemented their own system.
   */
  stateStudentId: text("state_student_id"),

  /**
   * Aadhaar number — stored in masked format ONLY ("XXXX XXXX 1234").
   * Storing full Aadhaar requires UIDAI authorization. Never store the
   * full 12-digit number. Used for APAAR ID verification cross-checks.
   */
  aadhaarMasked: text("aadhaar_masked"), // Only last 4 digits: "XXXX XXXX 1234"

  /**
   * Name exactly as it appears on the student's Aadhaar card.
   * Often different from the school record name due to spellings.
   * UDISE+ and APAAR generation require the Aadhaar-matching name.
   */
  aadhaarName: text("aadhaar_name"), // Name as on Aadhaar card — may differ from school records

  /**
   * Whether the school has physically verified the student's Aadhaar.
   * Drives the "UDISE Progress" completeness indicator on the student profile.
   */
  isAadhaarVerified: integer("is_aadhaar_verified", { mode: "boolean" })
    .default(false)
    .notNull(),

  /**
   * UDISE+ migration/verification status — tracks whether this student's
   * data has been manually verified/entered against the UDISE+ portal.
   * When true, all government IDs (PEN, APAAR) are confirmed accurate.
   */
  udiseVerified: integer("udise_verified", { mode: "boolean" })
    .default(false)
    .notNull(),

  // ── UDISE+ DEMOGRAPHIC FIELDS (numeric codes for frictionless Excel export) ──

  /**
   * Social category as per UDISE+ code book.
   * 1=General, 2=SC, 3=ST, 4=OBC, 5=OBC-NCL.
   * Stored as integer — maps directly to the UDISE+ Excel column value.
   * Required for government scholarship schemes and reservation tracking.
   */
  socialCategory: integer("social_category").$type<SocialCategoryValue>(),

  /**
   * Religion as per UDISE+ code book.
   * 1=Hindu, 2=Muslim, 3=Christian, 4=Sikh, 5=Buddhist, 6=Jain, 7=Others, 8=No Religion.
   * Stored as integer — maps directly to the UDISE+ Excel column value.
   */
  religion: integer("religion").$type<ReligionValue>(),

  /**
   * Whether the student belongs to a religious minority community.
   * Determines eligibility for minority scholarship schemes (PM Scholarship, etc.).
   * UDISE+ tracks this separately from religion for policy targeting.
   */
  isMinority: integer("is_minority", { mode: "boolean" })
    .default(false)
    .notNull(),

  /**
   * Mother tongue / first language of the student.
   * UDISE+ uses Census of India language codes (e.g., Hindi=22, Bengali=5).
   * Stored as integer code. A reference table or enum can be added later.
   * Used for medium of instruction reporting and language policy compliance.
   */
  motherTongueCode: integer("mother_tongue_code"), // Census of India language code

  // ── SOCIO-ECONOMIC FIELDS ─────────────────────────────────────────────────

  /**
   * Below Poverty Line status.
   * BPL students are eligible for additional government schemes:
   * free uniforms, scholarships, transport subsidies.
   * Verified against family's BPL ration card.
   */
  isBpl: integer("is_bpl", { mode: "boolean" }).default(false).notNull(),

  /**
   * Locality type of the student's residence.
   * URBAN or RURAL — determined by the student's home pincode / address.
   * UDISE+ requires this for rural development and urban poverty scheme targeting.
   */
  localityType: text("locality_type").$type<LocalityTypeValue>(),

  // ── CWSN (CHILDREN WITH SPECIAL NEEDS) ───────────────────────────────────

  /**
   * Whether the student is a Child With Special Needs (CWSN).
   * Drives the CWSN section of the UDISE+ submission.
   * Schools with CWSN students receive additional government grants.
   */
  isCwsn: integer("is_cwsn", { mode: "boolean" }).default(false).notNull(),

  /**
   * Type of disability if isCwsn = true.
   * Uses UDISE+ disability code book (1–9).
   * NULL when isCwsn = false.
   */
  disabilityType: integer("disability_type").$type<DisabilityTypeValue>(),

  /**
   * Whether the student has a valid disability certificate (UDID card).
   * UDID = Unique Disability ID issued by MSJE (Ministry of Social Justice).
   * Progressively mandatory for CWSN students under RPWD Act 2016.
   */
  hasDisabilityCertificate: integer("has_disability_certificate", {
    mode: "boolean",
  }).default(false),

  /**
   * UDID (Unique Disability ID) card number.
   * 18-character alphanumeric. Issued by Swavlamban Health Card / MSJE.
   * Only relevant when hasDisabilityCertificate = true.
   */
  udidNumber: text("udid_number"),

  // ── GOVERNMENT FACILITIES & SCHEMES ──────────────────────────────────────

  /**
   * List of government facilities/schemes received by this student.
   * Stored as a JSON array of FacilityReceived codes.
   * Example: '["FREE_TEXTBOOKS", "FREE_UNIFORM", "MID_DAY_MEAL"]'
   *
   * UDISE+ Section: "Incentives and Facilities Received by Students"
   * Used to measure scheme reach and for fund disbursement verification.
   *
   * Query pattern: Use JSON_EACH() in SQLite or parse in application layer.
   * Export pattern: Map each code to its UDISE+ column (one boolean column per facility).
   */
  facilitiesReceived: text("facilities_received").default("[]"), // JSON array of FacilityReceived codes

  // ── HEALTH & MEDICAL ─────────────────────────────────────────────────────

  /**
   * Free-text medical information.
   * Allergies, chronic conditions, emergency medication notes.
   * For internal school use — NOT exported to UDISE+.
   * Visible only to school staff with appropriate permissions.
   */
  medicalInfo: text("medical_info"),
},
(table) => ({
  // Enforces the "unique per school" promise the old comment made but
  // never actually implemented at the DB level. NULLs are exempt, so
  // students with no admission number yet don't conflict with each other.
  admissionNumberUnique: uniqueIndex("idx_students_admission_number_unique").on(
    table.admissionNumber
  ),
})
);

export type Student = typeof studentsSchema.$inferSelect;
export type NewStudent = typeof studentsSchema.$inferInsert;
