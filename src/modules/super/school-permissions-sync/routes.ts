// …/super/school-permissions-sync/routes.ts
// Mount in src/index.ts as:  app.route("/school-permissions-sync", schoolPermissionsSyncRouter)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../types/common-types";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";

import { getCommonDB } from "../../../db";
import { schoolsSchema as superSchoolsSchema } from "../../../db/schemas/super";
import { eq } from "drizzle-orm";
import {
  hardResetPermissions,
  syncAllSchools,
  syncPermissionsAndRoles,
} from "../../school/permissions/sync-service";

const schoolPermissionsSyncRouter = new Hono<Env>();

// All routes require super auth + schools.manage permission
schoolPermissionsSyncRouter.use(
  "*",
  jwtMiddleware,
  superTokenValidationMiddleware
);

// ─── GET /school-permissions-sync/status ─────────────────────────────────────
// Returns all active schools with a lightweight "needs sync?" flag.
// "needs sync" = the school's permission count < ALL_PERMISSION_SLUGS.length.
// We keep this cheap — one query to the super DB, one per school is too slow.
schoolPermissionsSyncRouter.get(
  "/status",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const commonDb = getCommonDB(c.env);

      const schools = await commonDb
        .select({
          id: superSchoolsSchema.id,
          name: superSchoolsSchema.name,
          uniqueCode: superSchoolsSchema.uniqueCode,
          isActive: superSchoolsSchema.isActive,
          onboardingStatus: superSchoolsSchema.onboardingStatus,
        })
        .from(superSchoolsSchema)
        .where(eq(superSchoolsSchema.isActive, true))
        .all();

      return c.json({ success: true, schools });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 500);
    }
  }
);

// ─── POST /school-permissions-sync/sync/:schoolCode ──────────────────────────
// Sync permissions for a single school.
schoolPermissionsSyncRouter.post(
  "/sync/:schoolCode",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const schoolCode = c.req.param("schoolCode")?.trim().toUpperCase();
      if (!schoolCode) {
        return c.json({ success: false, error: "schoolCode is required" }, 400);
      }

      // Verify school exists and is active
      const commonDb = getCommonDB(c.env);
      const school = await commonDb
        .select({
          uniqueCode: superSchoolsSchema.uniqueCode,
          isActive: superSchoolsSchema.isActive,
        })
        .from(superSchoolsSchema)
        .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
        .get();

      if (!school) {
        return c.json({ success: false, error: "School not found" }, 404);
      }
      if (!school.isActive) {
        return c.json({ success: false, error: "School is not active" }, 400);
      }

      const result = await syncPermissionsAndRoles(c.env, schoolCode);

      if (result.error) {
        return c.json({ success: false, error: result.error, result }, 500);
      }

      return c.json({ success: true, result });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 500);
    }
  }
);

// ─── POST /school-permissions-sync/sync-all ───────────────────────────────────
// Sync all active schools in sequence. Can take a while for large deployments.
schoolPermissionsSyncRouter.post(
  "/sync-all",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const batchResult = await syncAllSchools(c.env);
      return c.json({ success: true, ...batchResult });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 500);
    }
  }
);

// ─── POST /school-permissions-sync/hard-reset/:schoolCode ────────────────────
// ⚠️  DEVELOPMENT-ONLY — DESTRUCTIVE ⚠️
//
// Wipes and re-seeds the entire permission system for a single school.
// Use when the permission schema has changed significantly and an additive
// sync cannot fix stale data (wrong categories, renamed slugs, etc.).
//
// Impact:
//   • All role_permissions links deleted and re-created from DEFAULT_ROLE_PERMISSIONS.
//   • All user_roles assignments deleted — every user loses their role.
//   • All user_permissions overrides deleted.
//   • All roles (including custom ones) deleted and re-created as system defaults.
//   • All permissions deleted and re-inserted with correct categories.
//
// The school owner must be manually re-assigned their SCHOOL_OWNER role after
// this operation. This is expected in a development workflow.
//
// DO NOT expose this in production builds.
schoolPermissionsSyncRouter.post(
  "/hard-reset/:schoolCode",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const schoolCode = c.req.param("schoolCode")?.trim().toUpperCase();
      if (!schoolCode) {
        return c.json({ success: false, error: "schoolCode is required" }, 400);
      }

      // ── Require explicit confirmation header to prevent accidental calls ──
      // The frontend sends this header only after the user types the school
      // code in a confirmation dialog.
      const confirmationHeader = c.req.header("X-Confirm-Hard-Reset");
      if (confirmationHeader !== schoolCode) {
        return c.json(
          {
            success: false,
            error:
              "Missing or incorrect confirmation. Send header X-Confirm-Hard-Reset: <schoolCode>",
          },
          400
        );
      }

      const commonDb = getCommonDB(c.env);
      const school = await commonDb
        .select({
          uniqueCode: superSchoolsSchema.uniqueCode,
          isActive: superSchoolsSchema.isActive,
          name: superSchoolsSchema.name,
        })
        .from(superSchoolsSchema)
        .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
        .get();

      if (!school) {
        return c.json({ success: false, error: "School not found" }, 404);
      }
      if (!school.isActive) {
        return c.json({ success: false, error: "School is not active" }, 400);
      }

      const result = await hardResetPermissions(c.env, schoolCode);

      if (result.error) {
        return c.json({ success: false, error: result.error, result }, 500);
      }

      return c.json({
        success: true,
        warning:
          "All user role assignments have been cleared. Users must be re-assigned their roles.",
        result,
      });
    } catch (err: any) {
      return c.json({ success: false, error: err.message }, 500);
    }
  }
);

export default schoolPermissionsSyncRouter;
