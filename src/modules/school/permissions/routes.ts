// …/school/permissions/routes.ts

import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getSchoolDB } from "../../../db/school-client";
import { schoolPermissionsSchema } from "../../../db/schemas/school";
import { PermissionCategory } from "../../../types/school-permissions";
import { eq } from "drizzle-orm";

const schoolPermissionsRouter = new Hono<SchoolEnv>();

// ==================== APPLY AUTH MIDDLEWARES ====================
schoolPermissionsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ==================== GET ALL PERMISSIONS ====================
// GET /school/permissions
// GET /school/permissions?category=staff
// GET /school/permissions?category=student
// GET /school/permissions?category=parent
//
// Used by:
//   1. Role form dialog — passes ?category=<roleCategory> to show only
//      permissions in the correct universe.
//   2. User direct-permission form — passes ?category=<userPrimaryRoleCategory>
//      to show only permissions relevant to the user's role universe.
//
// When `category` is omitted, ALL permissions are returned (backward compat,
// used by super-admin tooling). In practice the frontend always passes a
// category when rendering permission pickers.
//
// Guard: roles.manage — only staff with role management permission can
// fetch permissions (same guard as before).
schoolPermissionsRouter.get(
  "/",
  requirePermission("roles.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      // ── Read optional category filter from query string ────────────────
      const rawCategory = c.req.query("category");

      // Validate the category value if present — reject unknown values
      // to prevent accidental data leaks from typos.
      const validCategories: PermissionCategory[] = [
        "staff",
        "student",
        "parent",
      ];
      const category: PermissionCategory | null =
        rawCategory &&
        validCategories.includes(rawCategory as PermissionCategory)
          ? (rawCategory as PermissionCategory)
          : null;

      if (rawCategory && !category) {
        return c.json(
          {
            success: false,
            error: `Invalid category "${rawCategory}". Must be one of: staff, student, parent`,
          },
          400
        );
      }

      // ── Build query — apply category filter when present ──────────────
      const baseQuery = db
        .select({
          id: schoolPermissionsSchema.id,
          slug: schoolPermissionsSchema.slug,
          name: schoolPermissionsSchema.name,
          description: schoolPermissionsSchema.description,
          module: schoolPermissionsSchema.module,
          category: schoolPermissionsSchema.category,
        })
        .from(schoolPermissionsSchema);

      const permissions = category
        ? await baseQuery
            .where(eq(schoolPermissionsSchema.category, category))
            .orderBy(
              schoolPermissionsSchema.module,
              schoolPermissionsSchema.slug
            )
            .all()
        : await baseQuery
            .orderBy(
              schoolPermissionsSchema.module,
              schoolPermissionsSchema.slug
            )
            .all();

      return c.json({ success: true, permissions });
    } catch (error: any) {
      console.error("Get permissions error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to load permissions",
        },
        500
      );
    }
  }
);

export default schoolPermissionsRouter;
