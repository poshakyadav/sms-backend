// src/modules/school/roles/routes.ts
// UPDATED: createRoleSchema now requires `category` field.
// updateRoleSchema intentionally omits `category` (immutable after creation).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  cloneRole,
  getRoleTemplates,
} from "./services";

const rolesRouter = new Hono<SchoolEnv>();

// ==================== APPLY AUTH MIDDLEWARES ====================
rolesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== GET ALL ROLES ====================
// Accepts an optional ?category=staff|student|parent query param.
// When present, only roles of that category are returned.
// This drives the "Additional Roles" dropdown in user-form — it filters
// the list to the same category as the user's primary role so cross-
// category role assignments are impossible from the UI.
rolesRouter.get("/", requirePermission("roles.manage"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const categoryParam = c.req.query("category") as
      | "staff"
      | "student"
      | "parent"
      | undefined;
 
    const roles = await getAllRoles(c.env, schoolCode, categoryParam);
    return c.json({ success: true, roles });
  } catch (error: any) {
    console.error("Get roles error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET ROLE BY ID ====================
rolesRouter.get("/:id", requirePermission("roles.manage"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid role ID" }, 400);
    }

    const schoolCode = c.get("schoolCode")!;
    const role = await getRoleById(c.env, schoolCode, id);

    if (!role) {
      return c.json({ success: false, error: "Role not found" }, 404);
    }

    return c.json({ success: true, role });
  } catch (error: any) {
    console.error("Get role error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET ROLE TEMPLATES ====================
rolesRouter.get(
  "/templates/list",
  requirePermission("roles.manage"),
  async (c) => {
    try {
      const templates = getRoleTemplates();
      return c.json({ success: true, templates });
    } catch (error: any) {
      console.error("Get templates error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== CREATE ROLE SCHEMA ====================
// UPDATED: `category` is now required. The frontend role-form-dialog
// shows a category selector in create mode, and the chosen category
// determines which permissions are loaded and submitted.
const createRoleSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(5).max(500),
  permissionIds: z
    .array(z.number().int().positive())
    .min(1, "At least one permission required"),
  category: z.enum(["staff", "student", "parent"] as const, {
    error: "Category must be one of: staff, student, parent",
  }),
  templateId: z.string().optional(),
});

// ==================== CREATE ROLE ====================
rolesRouter.post(
  "/",
  requirePermission("roles.manage"),
  zValidator("json", createRoleSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const creator = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await createRole(c.env, schoolCode, data, creator.id);

      return c.json(
        {
          success: true,
          message: "Role created successfully",
          role: result.role,
        },
        201
      );
    } catch (error: any) {
      console.error("Create role error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to create role",
        },
        400
      );
    }
  }
);

// ==================== UPDATE ROLE SCHEMA ====================
// NOTE: `category` is deliberately excluded from update — it is immutable.
// The backend reads the existing category from the DB and validates
// submitted permissions against it.
const updateRoleSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().min(5).max(500).optional(),
  permissionIds: z.array(z.number().int().positive()).optional(),
});

// ==================== UPDATE ROLE ====================
rolesRouter.put(
  "/:id",
  requirePermission("roles.manage"),
  zValidator("json", updateRoleSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) {
        return c.json({ success: false, error: "Invalid role ID" }, 400);
      }

      const data = c.req.valid("json");
      const updater = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      await updateRole(c.env, schoolCode, id, data, updater.id);

      return c.json({
        success: true,
        message: "Role updated successfully",
      });
    } catch (error: any) {
      console.error("Update role error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to update role",
        },
        400
      );
    }
  }
);

// ==================== CLONE ROLE ====================
const cloneRoleSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().optional(),
});

rolesRouter.post(
  "/:id/clone",
  requirePermission("roles.manage"),
  zValidator("json", cloneRoleSchema),
  async (c) => {
    try {
      const sourceRoleId = parseInt(c.req.param("id"));
      if (isNaN(sourceRoleId)) {
        return c.json({ success: false, error: "Invalid role ID" }, 400);
      }

      const data = c.req.valid("json");
      const creator = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await cloneRole(
        c.env,
        schoolCode,
        sourceRoleId,
        data,
        creator.id
      );

      return c.json(
        {
          success: true,
          message: "Role cloned successfully",
          role: result.role,
        },
        201
      );
    } catch (error: any) {
      console.error("Clone role error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to clone role",
        },
        400
      );
    }
  }
);

// ==================== DELETE ROLE ====================
rolesRouter.delete("/:id", requirePermission("roles.manage"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid role ID" }, 400);
    }

    const schoolCode = c.get("schoolCode")!;
    await deleteRole(c.env, schoolCode, id);

    return c.json({
      success: true,
      message: "Role deleted successfully",
    });
  } catch (error: any) {
    console.error("Delete role error:", error);
    return c.json(
      {
        success: false,
        error: error.message || "Failed to delete role",
      },
      400
    );
  }
});

export default rolesRouter;
