// src/modules/school/users/routes.ts

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  assignDirectPermissionsToUser,
  assignRolesToUser,
  bulkUploadStudentAvatars,
  changeSchoolUserUsername,
  checkUserDeletionImpact,
  createSchoolUser,
  deleteSchoolUser,
  getSchoolUserById,
  getSchoolUsers,
  getSchoolUsersByCategory,
  getStudentsByClassSectionForAvatarUpload,
  getUserDeniedPermissions,
  getUserDirectPermissions,
  getUserRoles,
  removeSchoolUserAvatar,
  updateSchoolUser,
  uploadSchoolUserAvatar,
} from "./services";
import { getSchoolDB } from "../../../db/school-client";
import { schoolUsersSchema, studentsSchema } from "../../../db/schemas/school";
import { eq } from "drizzle-orm";
import { PermissionCategory } from "../../../types/school-permissions";
import { normalizeUsername, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_REGEX } from "../../../utils/school/username";

const usersRouter = new Hono<SchoolEnv>();

// ==================== APPLY AUTH MIDDLEWARES ====================
usersRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== GET ALL USERS ====================
usersRouter.get("/", requirePermission("users.list"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const users = await getSchoolUsers(c.env, schoolCode);
    return c.json({ success: true, users });
  } catch (error: any) {
    console.error("Get users error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET USERS BY CATEGORY ====================
// GET /school/users/by-category?category=staff|student|parent
usersRouter.get("/by-category", requirePermission("users.list"), async (c) => {
  try {
    const categoryParam = c.req.query("category");
    const validCategories: PermissionCategory[] = [
      "staff",
      "student",
      "parent",
    ];

    if (
      !categoryParam ||
      !validCategories.includes(categoryParam as PermissionCategory)
    ) {
      return c.json(
        {
          success: false,
          error: `Invalid or missing 'category' query param. Must be one of: ${validCategories.join(
            ", "
          )}`,
        },
        400
      );
    }

    const schoolCode = c.get("schoolCode")!;
    const users = await getSchoolUsersByCategory(
      c.env,
      schoolCode,
      categoryParam as PermissionCategory
    );

    return c.json({ success: true, users, category: categoryParam });
  } catch (error: any) {
    console.error("Get users by category error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== CHECK EMAIL AVAILABILITY ====================
// IMPORTANT: Must be defined before GET /:id to avoid route collision.
usersRouter.get(
  "/check-email",
  requirePermission("users.create"),
  async (c) => {
    try {
      const email = c.req.query("email")?.toLowerCase().trim();

      if (!email) {
        return c.json(
          { success: false, error: "Email query param is required" },
          400
        );
      }

      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(email)) {
        return c.json({ success: false, error: "Invalid email format" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const existing = await db
        .select({ id: schoolUsersSchema.id })
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.email, email))
        .get();

      return c.json({
        success: true,
        available: !existing,
        message: existing
          ? "This email is already registered. Please use a different email."
          : "Email is available.",
      });
    } catch (error: any) {
      console.error("Check email error:", error);
      return c.json(
        { success: false, error: error.message || "Server error" },
        500
      );
    }
  }
);

// ==================== CHECK USERNAME AVAILABILITY ====================
// IMPORTANT: Must be defined before GET /:id to avoid route collision.
usersRouter.get(
  "/check-username",
  requirePermission(["users.create", "users.edit"]),
  async (c) => {
    try {
      const raw = c.req.query("username");
      if (!raw) {
        return c.json(
          { success: false, error: "username query param is required" },
          400
        );
      }

      const username = normalizeUsername(raw);

      if (!USERNAME_REGEX.test(username)) {
        return c.json({
          success: true,
          available: false,
          message: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers.`,
        });
      }

      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const existing = await db
        .select({ id: schoolUsersSchema.id })
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.username, username))
        .get();

      return c.json({
        success: true,
        available: !existing,
        message: existing
          ? "This username is already taken. Please choose a different one."
          : "Username is available.",
      });
    } catch (error: any) {
      console.error("Check username error:", error);
      return c.json(
        { success: false, error: error.message || "Server error" },
        500
      );
    }
  }
);

// ==================== CHECK ADMISSION NUMBER AVAILABILITY ====================
// IMPORTANT: Must be defined before GET /:id to avoid route collision.
usersRouter.get(
  "/check-admission-number",
  requirePermission(["users.create", "users.edit"]),
  async (c) => {
    try {
      const raw = c.req.query("admissionNumber")?.trim();
      if (!raw) {
        return c.json(
          { success: false, error: "admissionNumber query param is required" },
          400
        );
      }

      // Allows the edit form to check availability while excluding the
      // student's own current record (same pattern you'd want for email).
      const excludeUserIdRaw = c.req.query("excludeUserId");
      const excludeUserId = excludeUserIdRaw ? parseInt(excludeUserIdRaw) : undefined;

      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const existing = await db
        .select({ userId: studentsSchema.userId })
        .from(studentsSchema)
        .where(eq(studentsSchema.admissionNumber, raw))
        .get();

      const available = !existing || existing.userId === excludeUserId;

      return c.json({
        success: true,
        available,
        message: available
          ? "Admission number is available."
          : "This admission number is already assigned to another student.",
      });
    } catch (error: any) {
      console.error("Check admission number error:", error);
      return c.json(
        { success: false, error: error.message || "Server error" },
        500
      );
    }
  }
);

// ── Bulk photo upload limits ────────────────────────────────────────────────
const MAX_BULK_AVATAR_ITEMS = 100; // sane ceiling — largest realistic class-section is ~60
const MAX_AVATAR_BYTES_BULK = 100 * 1024; // same 100KB ceiling as single avatar upload

const bulkAvatarStudentIdsSchema = z
  .array(z.number().int().positive())
  .min(1, "At least one student is required")
  .max(
    MAX_BULK_AVATAR_ITEMS,
    `Cannot upload more than ${MAX_BULK_AVATAR_ITEMS} photos in a single request`
  );

// ─────────────────────────────────────────────────────────────────────────────
// BULK PHOTO UPLOAD — class-section based
// IMPORTANT: Defined before GET /:id and use static path segments, so no
// collision risk, but kept here with the other pre-`/:id` routes for
// consistency with the rest of this file.
// ─────────────────────────────────────────────────────────────────────────────

usersRouter.get(
  "/class-section/:classSectionId/students",
  requirePermission("users.list"),
  async (c) => {
    try {
      const classSectionId = parseInt(c.req.param("classSectionId"));
      if (isNaN(classSectionId)) {
        return c.json(
          { success: false, error: "Invalid class section ID" },
          400
        );
      }

      const schoolCode = c.get("schoolCode")!;
      const students = await getStudentsByClassSectionForAvatarUpload(
        c.env,
        schoolCode,
        classSectionId
      );

      return c.json({ success: true, students });
    } catch (error: any) {
      console.error("Get students by class-section error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// POST /school/users/bulk-avatar-upload
// Body: multipart/form-data
//   studentIds  -> JSON string, e.g. "[12,13,14]"
//   avatar_<id> -> one file field PER student id in studentIds, e.g.
//                  "avatar_12", "avatar_13", "avatar_14"
//
// Files are matched to students BY FIELD NAME, not by array position — this
// sidesteps any ambiguity about FormData iteration/multipart ordering.
// Accepts the same permission set as the single-avatar endpoint since both
// serve the same "manage a student's profile photo" capability.
usersRouter.post(
  "/bulk-avatar-upload",
  requirePermission(["users.create", "users.edit"]),
  async (c) => {
    try {
      const body = await c.req.parseBody();

      const studentIdsRaw = body["studentIds"];
      if (typeof studentIdsRaw !== "string") {
        return c.json(
          { success: false, error: "studentIds field is required" },
          400
        );
      }

      let studentIds: number[];
      try {
        studentIds = bulkAvatarStudentIdsSchema.parse(
          JSON.parse(studentIdsRaw)
        );
      } catch (e: any) {
        return c.json(
          {
            success: false,
            error: e?.errors?.[0]?.message ?? "Invalid studentIds payload",
          },
          400
        );
      }

      const items: { userId: number; bytes: ArrayBuffer; contentType: string }[] =
        [];
      const missing: number[] = [];

      for (const userId of studentIds) {
        const file = body[`avatar_${userId}`];

        if (!file || typeof file === "string") {
          missing.push(userId);
          continue;
        }

        const contentType = (file as File).type || "image/webp";
        if (!contentType.startsWith("image/")) {
          return c.json(
            {
              success: false,
              error: `File for student #${userId} is not an image`,
            },
            400
          );
        }

        const arrayBuffer = await (file as File).arrayBuffer();
        if (arrayBuffer.byteLength > MAX_AVATAR_BYTES_BULK) {
          return c.json(
            {
              success: false,
              error: `Image for student #${userId} is too large (${Math.round(
                arrayBuffer.byteLength / 1024
              )}KB). Max ${MAX_AVATAR_BYTES_BULK / 1024}KB.`,
            },
            400
          );
        }

        items.push({ userId, bytes: arrayBuffer, contentType });
      }

      if (missing.length > 0) {
        return c.json(
          {
            success: false,
            error: `Missing image file(s) for student ID(s): ${missing.join(
              ", "
            )}`,
          },
          400
        );
      }

      const schoolCode = c.get("schoolCode")!;
      const result = await bulkUploadStudentAvatars(c.env, schoolCode, items);

      return c.json({
        success: true,
        message:
          result.failed.length > 0
            ? `${result.uploaded.length} photo(s) uploaded, ${result.failed.length} failed`
            : `${result.uploaded.length} photo(s) uploaded successfully`,
        uploaded: result.uploaded,
        failed: result.failed,
      });
    } catch (error: any) {
      console.error("Bulk avatar upload error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to bulk upload photos" },
        500
      );
    }
  }
);

// ==================== PRE-DELETE IMPACT CHECK ====================
// GET /school/users/:id/deletion-check
usersRouter.get(
  "/:id/deletion-check",
  requirePermission("users.delete"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid user ID" }, 400);

      const schoolCode = c.get("schoolCode")!;
      const result = await checkUserDeletionImpact(c.env, schoolCode, id);

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Deletion check error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET USER BY ID ====================
usersRouter.get("/:id", requirePermission("users.list"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid user ID" }, 400);
    }

    const schoolCode = c.get("schoolCode")!;
    const user = await getSchoolUserById(c.env, schoolCode, id);

    if (!user) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    return c.json({ success: true, user });
  } catch (error: any) {
    console.error("Get user error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED FIELD SCHEMAS
// Defined once, referenced in both create and update schemas.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common identity fields shared across all user types.
 * These live on the school_users table.
 */
const commonUserFields = {
  // Contact
  phone: z.string().min(10).max(15).optional(),
  alternatePhone: z.string().min(10).max(15).optional(),

  // Personal
  dateOfBirth: z.string().date().optional(),
  gender: z.enum(["MALE", "FEMALE", "TRANSGENDER"]).optional(),
  bloodGroup: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional(),
  avatarUrl: z.string().url().optional(),

  // Address
  addressLineOne: z.string().max(255).optional(),
  addressLineTwo: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),

  // ── NEW: Parental/Guardian fields (school_users table) ─────────────────────
  // Required for UDISE+, TC generation, and emergency contacts.
  fatherName: z.string().max(150).optional(),
  motherName: z.string().max(150).optional(),
  guardianName: z.string().max(150).optional(),
  guardianRelation: z.string().max(100).optional(),
};

/**
 * Student-specific profile fields (students table — existing + UDISE fields).
 */
const studentProfileFields = {
  // ── Existing school-internal fields ────────────────────────────────────────
  admissionNumber: z.string().trim().max(50).optional(),
  rollNumber: z.string().max(50).optional(),
  admissionDate: z.string().date().optional(),
  previousSchool: z.string().max(255).optional(),
  medicalInfo: z.string().max(1000).optional(),

  // ── UDISE / National identity fields ───────────────────────────────────────
  /**
   * Permanent Education Number — 16-digit numeric string.
   * Collected from previous school TC or UDISE+ portal.
   */
  pen: z
    .string()
    .regex(/^\d{16}$/, "PEN must be exactly 16 digits")
    .optional()
    .nullable(),

  /**
   * APAAR ID (Academic Bank of Credits / ABC ID) — 12-digit numeric string.
   * Part of NEP 2020. Linked to Aadhaar.
   */
  apaarId: z
    .string()
    .regex(/^\d{12}$/, "APAAR ID must be exactly 12 digits")
    .optional()
    .nullable(),

  /**
   * State-level student tracking ID (SAMAGRA, U-DISE Student ID, etc.).
   * Format varies by state — stored as free text.
   */
  stateStudentId: z.string().max(50).optional().nullable(),

  /**
   * Aadhaar — ONLY the masked version ("XXXX XXXX 1234") must be stored.
   * Full 12-digit Aadhaar must NEVER be stored without UIDAI authorization.
   */
  aadhaarMasked: z
    .string()
    .regex(
      /^XXXX XXXX \d{4}$/,
      'Aadhaar must be in masked format "XXXX XXXX 1234"'
    )
    .optional()
    .nullable(),

  /**
   * Name as printed on the student's Aadhaar card.
   * May differ from the school record name due to spelling variants.
   */
  aadhaarName: z.string().max(150).optional().nullable(),

  /**
   * UDISE code of the previous school — 11-digit numeric string.
   * Required by UDISE+ when the student transfers from another school.
   */
  previousSchoolUdiseCode: z
    .string()
    .regex(/^\d{11}$/, "Previous school UDISE code must be exactly 11 digits")
    .optional()
    .nullable(),

  // ── UDISE+ demographic fields ───────────────────────────────────────────────

  /**
   * Enrollment type as per UDISE+ classification.
   * REGULAR (default), PRIVATE, or OPEN_SCHOOL.
   */
  enrollmentType: z.enum(["REGULAR", "PRIVATE", "OPEN_SCHOOL"]).optional(),

  /**
   * Previous class result — how the student exited their last class.
   * PROMOTED, NOT_PROMOTED, NEW_ADMISSION, or TRANSFERRED.
   */
  previousClassResult: z
    .enum(["PROMOTED", "NOT_PROMOTED", "NEW_ADMISSION", "TRANSFERRED"])
    .optional()
    .nullable(),

  /**
   * Social category as per UDISE+ code book.
   * 1=General, 2=SC, 3=ST, 4=OBC, 5=OBC-NCL, 6=Minority.
   */
  socialCategory: z.number().int().min(1).max(6).optional().nullable(),

  /**
   * Religion as per UDISE+ code book.
   * 1=Hindu, 2=Muslim, 3=Christian, 4=Sikh, 5=Buddhist, 6=Jain, 7=Others, 8=No Religion.
   */
  religion: z.number().int().min(1).max(8).optional().nullable(),

  /**
   * Whether the student belongs to a religious minority community.
   * Affects eligibility for PM Scholarship and other minority schemes.
   */
  isMinority: z.boolean().optional(),

  /**
   * Mother tongue / first language — Census of India language code.
   * e.g. Hindi=22, Bengali=5. Stored as integer code.
   */
  motherTongueCode: z.number().int().positive().optional().nullable(),

  // ── Socio-economic fields ───────────────────────────────────────────────────
  /**
   * Below Poverty Line status.
   * Drives eligibility for free uniform, transport subsidy, scholarship schemes.
   */
  isBpl: z.boolean().optional(),

  /**
   * Locality type of student's residence — URBAN or RURAL.
   */
  localityType: z.enum(["URBAN", "RURAL"]).optional().nullable(),

  // ── CWSN (Children with Special Needs) ─────────────────────────────────────
  /**
   * Whether the student is a Child With Special Needs.
   * Drives the CWSN section of UDISE+ submission and additional grant eligibility.
   */
  isCwsn: z.boolean().optional(),

  /**
   * Type of disability — UDISE+ code book values (1–9).
   * Only relevant when isCwsn = true.
   */
  disabilityType: z.number().int().min(1).max(9).optional().nullable(),

  /**
   * Whether the student holds a valid UDID disability certificate.
   */
  hasDisabilityCertificate: z.boolean().optional(),

  /**
   * UDID card number — 18-character alphanumeric.
   * Only relevant when hasDisabilityCertificate = true.
   */
  udidNumber: z.string().max(30).optional().nullable(),

  // ── Government facilities & schemes ────────────────────────────────────────
  /**
   * Government facilities received by this student.
   * JSON array of string codes: FREE_TEXTBOOKS, FREE_UNIFORM, FREE_TRANSPORT,
   * FREE_BICYCLE, SCHOLARSHIP, MID_DAY_MEAL, FREE_STATIONERY, OTHERS.
   */
  facilitiesReceived: z
    .array(
      z.enum([
        "FREE_TEXTBOOKS",
        "FREE_UNIFORM",
        "FREE_TRANSPORT",
        "FREE_BICYCLE",
        "SCHOLARSHIP",
        "MID_DAY_MEAL",
        "FREE_STATIONERY",
        "OTHERS",
      ])
    )
    .optional(),

  // ── UDISE verification flags ────────────────────────────────────────────────
  /**
   * Whether the school has physically verified the student's Aadhaar.
   */
  isAadhaarVerified: z.boolean().optional(),

  /**
   * Whether all UDISE+ government IDs have been verified against the portal.
   */
  udiseVerified: z.boolean().optional(),
};

/**
 * Teacher-specific profile fields (teachers table).
 */
const teacherProfileFields = {
  qualification: z.string().max(200).optional(),
  experienceYears: z.number().int().min(0).optional(),
  specialization: z.string().max(200).optional(),
};

/**
 * Parent-specific profile fields (parents table).
 */
const parentProfileFields = {
  occupation: z.string().max(200).optional(),
};

/**
 * Staff-specific profile fields (staff table).
 */
const staffProfileFields = {
  department: z.string().max(200).optional(),
  salary: z.number().int().min(0).optional(),
  shift: z.string().max(100).optional(),
  joiningDate: z.string().date().optional(),
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE USER SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const createUserBaseSchema = z.object({
  // ── Core identity ───────────────────────────────────────────────────────────
  name: z.string().min(2).max(100),
  // Email is now OPTIONAL — a user can be created with just a username.
  email: z.string().email().optional(),

  // Optional at creation — if omitted, the service auto-generates a unique
  // one from `name`. If provided, it must already match the format rules;
  // availability is checked server-side (see /check-username for live UX).
  username: z
    .string()
    .transform((val) => val.trim().toLowerCase())
    .refine((val) => USERNAME_REGEX.test(val), {
      message: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers (a-z, 0-9).`,
    })
    .optional(),

  password: z.string().min(8).max(100),

  // ── Role assignment ─────────────────────────────────────────────────────────
  /**
   * PRIMARY ROLE — mandatory, immutable after creation.
   * Determines which profile table (students/teachers/parents/staff) stores
   * the user's extended data. Must be included in roleIds.
   */
  primaryRoleId: z.number().int().positive({
    message: "Primary role ID is required and must be a valid role.",
  }),
  roleIds: z
    .array(z.number().int().positive())
    .min(1, "At least one role is required"),

  // ── Common fields (school_users table) ─────────────────────────────────────
  ...commonUserFields,

  // ── Profile-specific fields ─────────────────────────────────────────────────
  // All optional at creation — the primary role determines which profile
  // table receives them. Fields not relevant to the role are silently ignored.
  ...studentProfileFields,
  ...teacherProfileFields,
  ...parentProfileFields,
  ...staffProfileFields,
});

/**
 * Cross-field validation: primaryRoleId must be present in roleIds.
 * Applied AFTER the base schema so .partial() can still be used on the base.
 */
const createUserSchema = createUserBaseSchema.refine(
  (data) => data.roleIds.includes(data.primaryRoleId),
  {
    message: "Primary role must be included in the assigned roles list.",
    path: ["primaryRoleId"],
  }
);

// ==================== CREATE USER ====================
usersRouter.post(
  "/",
  requirePermission("users.create"),
  zValidator("json", createUserSchema),
  async (c) => {
    try {
      const creator = c.get("user")!;
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await createSchoolUser(
        c.env,
        schoolCode,
        data,
        creator.id
      );

      return c.json(
        {
          success: true,
          message: "User created successfully",
          user: result.user,
        },
        201
      );
    } catch (error: any) {
      console.error("Create user error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to create user" },
        400
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE USER SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
// Derived from the BASE schema (no refinements) so .partial() works correctly.
// password, roleIds, primaryRoleId are excluded (handled by dedicated endpoints).
// newPassword and isActive are update-only additions.

const updateUserSchema = createUserBaseSchema
  .omit({ password: true, roleIds: true, primaryRoleId: true, username: true })
  .partial()
  .extend({
    newPassword: z.string().min(8).max(100).optional(),
    isActive: z.boolean().optional(),
  });

// ==================== UPDATE USER ====================
usersRouter.put(
  "/:id",
  requirePermission("users.edit"),
  zValidator("json", updateUserSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const data = c.req.valid("json");
      const updater = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      await updateSchoolUser(c.env, schoolCode, id, data, updater.id);

      return c.json({ success: true, message: "User updated successfully" });
    } catch (error: any) {
      console.error("Update user error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to update user" },
        400
      );
    }
  }
);

// NOTE on accepted permission: both users.create (so the creation-hub's
// post-create avatar upload works for someone who only has create rights,
// not edit) and users.edit (so the edit screen's "Change Photo" works) are
// accepted — mirrors how check-email is gated by users.create only because
// it's only ever called from the creation flow, but THIS endpoint is called
// from both flows.

// ==================== UPLOAD / REPLACE USER AVATAR ====================
// POST /school/users/:id/avatar
// Body: multipart/form-data with a single field "avatar" containing the
// already-compressed image (WebP, ≤ ~50KB) produced client-side.
usersRouter.post(
  "/:id/avatar",
  requirePermission(["users.create", "users.edit"]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const body = await c.req.parseBody();
      const file = body["avatar"];

      if (!file || typeof file === "string") {
        return c.json({ success: false, error: "No image file provided" }, 400);
      }

      // file is a File (Web API) when parseBody() encounters multipart data
      const arrayBuffer = await (file as File).arrayBuffer();
      const contentType = (file as File).type || "image/webp";

      if (!contentType.startsWith("image/")) {
        return c.json({ success: false, error: "File must be an image" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const result = await uploadSchoolUserAvatar(
        c.env,
        schoolCode,
        id,
        arrayBuffer,
        contentType
      );

      return c.json({
        success: true,
        message: "Profile photo updated successfully",
        avatarUrl: result.avatarUrl,
      });
    } catch (error: any) {
      console.error("Avatar upload error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to upload profile photo",
        },
        400
      );
    }
  }
);

// ==================== REMOVE USER AVATAR ====================
// POST /school/users/:id/avatar/remove
usersRouter.post(
  "/:id/avatar/remove",
  requirePermission(["users.create", "users.edit"]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      await removeSchoolUserAvatar(c.env, schoolCode, id);

      return c.json({ success: true, message: "Profile photo removed" });
    } catch (error: any) {
      console.error("Avatar remove error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to remove profile photo",
        },
        400
      );
    }
  }
);

// ==================== CHANGE USERNAME ====================
// PUT /school/users/:id/username
const changeUsernameSchema = z.object({
  username: z
    .string()
    .transform((val) => val.trim().toLowerCase())
    .refine((val) => USERNAME_REGEX.test(val), {
      message: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers (a-z, 0-9).`,
    }),
});

usersRouter.put(
  "/:id/username",
  requirePermission(["users.create", "users.edit"]),
  zValidator("json", changeUsernameSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const { username } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await changeSchoolUserUsername(c.env, schoolCode, id, username);

      return c.json({
        success: true,
        message: "Username updated successfully",
        username: result.username,
      });
    } catch (error: any) {
      console.error("Change username error:", error);
      const msg: string = error.message ?? "";
      const isTaken = msg.includes("already taken");
      return c.json(
        { success: false, error: msg || "Failed to update username" },
        isTaken ? 409 : 400
      );
    }
  }
);

// ==================== ASSIGN/UPDATE USER ROLES ====================
const assignRolesSchema = z.object({
  roleIds: z
    .array(z.number().int().positive())
    .min(1, "At least one role is required"),
});

usersRouter.put(
  "/:id/roles",
  requirePermission("users.assign-role"),
  zValidator("json", assignRolesSchema),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      if (isNaN(userId)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const { roleIds } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const updater = c.get("user")!;

      await assignRolesToUser(c.env, schoolCode, userId, roleIds, updater.id);

      return c.json({
        success: true,
        message: "User roles updated successfully",
      });
    } catch (error: any) {
      console.error("Assign roles error:", error);

      const msg: string = error.message ?? "";
      const isPrimaryRoleGuard = msg.includes("primary role");
      const isOwnerGuard =
        msg.includes("School Owner") || msg.includes("SCHOOL_OWNER");

      return c.json(
        {
          success: false,
          error: msg || "Failed to assign roles.",
          code: isPrimaryRoleGuard
            ? "PRIMARY_ROLE_GUARD"
            : isOwnerGuard
              ? "LAST_OWNER_GUARD"
              : undefined,
        },
        isPrimaryRoleGuard || isOwnerGuard ? 422 : 400
      );
    }
  }
);

// ==================== GET USER ROLES ====================
usersRouter.get("/:id/roles", requirePermission("users.list"), async (c) => {
  try {
    const userId = parseInt(c.req.param("id"));
    if (isNaN(userId)) {
      return c.json({ success: false, error: "Invalid user ID" }, 400);
    }

    const schoolCode = c.get("schoolCode")!;
    const roles = await getUserRoles(c.env, schoolCode, userId);

    return c.json({ success: true, roles });
  } catch (error: any) {
    console.error("Get user roles error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET USER DIRECT PERMISSIONS ====================
usersRouter.get(
  "/:id/permissions",
  requirePermission("users.list"),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      if (isNaN(userId)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const permissions = await getUserDirectPermissions(
        c.env,
        schoolCode,
        userId
      );

      return c.json({ success: true, permissions });
    } catch (error: any) {
      console.error("Get user permissions error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET USER DENIED PERMISSIONS ====================
usersRouter.get(
  "/:id/denied-permissions",
  requirePermission("users.list"),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      if (isNaN(userId)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const permissions = await getUserDeniedPermissions(
        c.env,
        schoolCode,
        userId
      );

      return c.json({ success: true, permissions });
    } catch (error: any) {
      console.error("Get denied permissions error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== ASSIGN DIRECT PERMISSIONS + DENIALS ====================
const assignPermissionsSchema = z.object({
  permissionIds: z.array(z.number().int().positive()),
  deniedPermissionIds: z.array(z.number().int().nonnegative()),
});

usersRouter.put(
  "/:id/permissions",
  requirePermission("permissions.manage"),
  zValidator("json", assignPermissionsSchema),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      if (isNaN(userId)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const { permissionIds, deniedPermissionIds } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const updater = c.get("user")!;

      await assignDirectPermissionsToUser(
        c.env,
        schoolCode,
        userId,
        permissionIds,
        deniedPermissionIds,
        updater.id
      );

      return c.json({
        success: true,
        message: "User permissions updated successfully",
      });
    } catch (error: any) {
      console.error("Assign permissions error:", error);

      const msg: string = error.message ?? "";
      const isCategoryMismatch = msg.includes("Category mismatch");

      return c.json(
        {
          success: false,
          error: msg || "Failed to assign permissions",
          code: isCategoryMismatch ? "CATEGORY_MISMATCH" : undefined,
        },
        isCategoryMismatch ? 422 : 400
      );
    }
  }
);

// ==================== DELETE USER ====================
usersRouter.delete("/:id", requirePermission("users.delete"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id))
      return c.json({ success: false, error: "Invalid user ID" }, 400);

    const deleter = c.get("user")!;
    if (id === deleter.id) {
      return c.json(
        { success: false, error: "Cannot delete your own account" },
        403
      );
    }

    const schoolCode = c.get("schoolCode")!;
    await deleteSchoolUser(c.env, schoolCode, id);
    return c.json({ success: true, message: "User deleted successfully" });
  } catch (error: any) {
    console.error("Delete user error:", error);
    return c.json(
      { success: false, error: error.message || "Failed to delete user" },
      400
    );
  }
});

export default usersRouter;
