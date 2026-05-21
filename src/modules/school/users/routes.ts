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
  checkUserDeletionImpact,
  createSchoolUser,
  deleteSchoolUser,
  getSchoolUserById,
  getSchoolUsers,
  getSchoolUsersByCategory,
  getUserDeniedPermissions,
  getUserDirectPermissions,
  getUserRoles,
  updateSchoolUser,
} from "./services";
import { getSchoolDB } from "../../../db/school-client";
import { schoolUsersSchema } from "../../../db/schemas/school";
import { eq } from "drizzle-orm";
import { PermissionCategory } from "../../../types/school-permissions";

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
  admissionNumber: z.string().max(50).optional(),
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
   * 1=General, 2=SC, 3=ST, 4=OBC, 5=OBC-NCL.
   */
  socialCategory: z.number().int().min(1).max(5).optional().nullable(),

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
  email: z.string().email(),
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
  .omit({ password: true, roleIds: true, primaryRoleId: true })
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
