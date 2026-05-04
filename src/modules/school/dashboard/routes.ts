// src/modules/school/dashboard/routes.ts
// reads role + X-Active-Child-Id, delegates to service
//  Production-grade school dashboard with PARENT persona support & child switching

// src/modules/school/dashboard/routes.ts
// Production-grade school dashboard with PARENT persona support & child switching

import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getDashboardData } from "./services";
import { getSchoolDB } from "../../../db/school-client";
import { schoolRolesSchema, schoolUserRolesSchema } from "../../../db/schemas/school";
import { eq } from "drizzle-orm";

const schoolDashboardRouter = new Hono<SchoolEnv>();

schoolDashboardRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

/**
 * GET /school/dashboard
 *
 * Returns a persona-aware dashboard payload.
 * For STUDENT_PARENT: reads X-Active-Child-Id header (set by auth interceptor)
 * to scope data to the selected child.
 * 
 * Role is resolved from JWT first, then falls back to a DB lookup if the
 * JWT claim is empty (which happened after token refresh before the auth fix).
 * This double-guard ensures the correct persona is ALWAYS returned.
 */
schoolDashboardRouter.get(
  "/",
  requirePermission(["dashboard.view", "dashboard.student.view", "dashboard.parent.view"]),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

       // ── Step 1: Try to resolve role from JWT payload ─────────────────────
      // The JWT payload is stored separately from SchoolUserContext.
      // We pull the role from the raw jwtPayload to avoid extending the type.
      const jwtPayload = c.get("jwtPayload") as any;
      let role: string = jwtPayload?.role ?? "";

      // ── Step 2: If role is missing from JWT (stale token from before
      //    the refresh fix), look it up directly from the DB as a safe fallback.
      //    This prevents GENERAL_STAFF being returned for OWNER/MANAGEMENT/etc.
      if (!role) {
        console.warn(
          `[Dashboard] JWT role missing for user ${user.id} — falling back to DB lookup`
        );
        try {
          const db = await getSchoolDB(c.env, schoolCode);
          const primaryRoleResult = await db
            .select({ name: schoolRolesSchema.name })
            .from(schoolUserRolesSchema)
            .innerJoin(
              schoolRolesSchema,
              eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
            )
            .where(eq(schoolUserRolesSchema.userId, user.id))
            .get();
          role = primaryRoleResult?.name ?? "";
          console.log(
            `[Dashboard] DB role fallback resolved: "${role}" for user ${user.id}`
          );
        } catch (dbErr) {
          console.error(
            "[Dashboard] DB role fallback failed:",
            dbErr
          );
          // role stays "" → resolvePersona will return GENERAL_STAFF as safe default
        }
      }

      // ── Step 3: Resolve active child for STUDENT_PARENT persona ──────────────────
      // The auth interceptor sets X-Active-Child-Id when role === STUDENT_PARENT
      const activeChildHeader = c.req.header("X-Active-Child-Id");
      const activeChildId = activeChildHeader
        ? parseInt(activeChildHeader, 10) || null
        : null;

      const data = await getDashboardData(
        c.env,
        schoolCode,
        user.id,
        role,
        // user.permissions ?? [],
        activeChildId
      );

      console.log("Data:  ", data);

      return c.json(data);
    } catch (error: any) {
      console.error("Dashboard error:", error);
      return c.json({ error: error.message || "Dashboard load failed" }, 500);
    }
  }
);

export default schoolDashboardRouter;
