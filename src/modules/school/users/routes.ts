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
usersRouter.get(
  "/",
  requirePermission("users.list"), // ← NEW: Permission-based
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const users = await getSchoolUsers(c.env, schoolCode);
      // console.log("Data : ", users);
      return c.json({ success: true, users });
    } catch (error: any) {
      console.error("Get users error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET USERS BY CATEGORY (NEW) ====================
// GET /school/users/by-category?category=staff|student|parent
//
// Used by the frontend tab UI to load only the users relevant to the
// active tab. Called only when the user clicks "Load" or switches tabs.
// Never returns passwordHash.
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
// IMPORTANT: This MUST be defined before GET /:id
// Otherwise Hono matches "check-email" as the :id param → parseInt("check-email") = NaN → 400
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

// ==================== PRE-DELETE IMPACT CHECK (NEW) ====================
// GET /school/users/:id/deletion-check
//
// Returns a structured DeletionCheckResult without performing any deletion.
// The frontend calls this when the user clicks the delete button and uses
// the result to render a detailed confirmation dialog.
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
usersRouter.get(
  "/:id",
  requirePermission("users.list"), // View user details
  async (c) => {
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
  }
);

// ==================== CREATE USER SCHEMA ====================
const createUserBaseSchema = z.object({
  // Basic Info
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),

  // ── PRIMARY ROLE — mandatory, immutable after creation ─────────────────
  // Must be one of the roleIds. This role permanently defines the user's
  // identity and which profile table (students/teachers/parents/staff)
  // stores their extended data.
  primaryRoleId: z.number().int().positive({
    message: "Primary role ID is required and must be a valid role.",
  }),

  // Role assignment (NEW: array of role IDs instead of single role enum)
  roleIds: z
    .array(z.number().int().positive())
    .min(1, "At least one role is required"),

  // Contact
  phone: z.string().min(10).max(15).optional(),
  alternatePhone: z.string().min(10).max(15).optional(),

  // Personal
  dateOfBirth: z.string().date().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
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

  // Profile-specific fields (we'll determine which profile to create based on role)
  // Student
  rollNumber: z.string().optional(),
  admissionDate: z.string().date().optional(),
  previousSchool: z.string().optional(),
  medicalInfo: z.string().optional(),

  // Teacher
  qualification: z.string().optional(),
  experienceYears: z.number().int().min(0).optional(),
  specialization: z.string().optional(),

  // Parent
  occupation: z.string().optional(),

  // Staff (for other roles)
  department: z.string().optional(),
  salary: z.number().int().min(0).optional(),
  shift: z.string().optional(),
  joiningDate: z.string().date().optional(),
});

// ==================== CREATE USER SCHEMA ====================
// Apply the cross-field refinement only here, AFTER the update schema has been
// derived from the base object above. This avoids the Zod runtime error:
//   "Error: .partial() cannot be used on object schemas containing refinements"
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
  requirePermission("users.create"), // ← NEW: Permission-based
  zValidator("json", createUserSchema),
  async (c) => {
    try {
      const creator = c.get("user")!;
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      // Create user with role assignments
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
        {
          success: false,
          error: error.message || "Failed to create user",
        },
        400
      );
    }
  }
);

/// ==================== UPDATE USER SCHEMA ====================
// Derived from the BASE schema (no refinements) so .partial() works correctly.
// - password and roleIds are omitted (handled by dedicated endpoints)
// - primaryRoleId is omitted (immutable after creation — cannot be changed via update)
// - newPassword and isActive are added as update-only fields
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
  requirePermission("users.edit"), // ← NEW: Permission-based
  zValidator("json", updateUserSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid user ID" }, 400);
      }

      const data = c.req.valid("json");
      console.log("Update data : ", data);
      const updater = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await updateSchoolUser(
        c.env,
        schoolCode,
        id,
        data,
        updater.id
      );

      return c.json({
        success: true,
        message: "User updated successfully",
      });
    } catch (error: any) {
      console.error("Update user error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to update user",
        },
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
// Returns permissions including their category field (updated service).
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

// ==================== ASSIGN DIRECT PERMISSIONS TO USER ====================
// UPDATED: The service now validates that all permissionIds belong to the
// same category as the user's primaryRole. Returns a 400 with a clear message
// if any cross-category permissions are submitted.
const assignPermissionsSchema = z.object({
  permissionIds: z.array(z.number().int().positive()),
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

      const { permissionIds } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const updater = c.get("user")!;

      await assignDirectPermissionsToUser(
        c.env,
        schoolCode,
        userId,
        permissionIds,
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
    // Pass through the structured error message for the frontend dialog
    return c.json(
      { success: false, error: error.message || "Failed to delete user" },
      400
    );
  }
});

export default usersRouter;
