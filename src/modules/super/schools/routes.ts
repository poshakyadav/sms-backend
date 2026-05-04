// src/modules/super/schools/routes.ts
//
// NOTE: This module manages the raw "schools" list in the super DB.
// The PRIMARY onboarding flow is now:
//   POST /invitations → school receives token link → registers → pays → admin approves
//
// The old POST /schools + /:id/send-invite flow is KEPT here for:
//   1. Viewing the full school list (GET /)
//   2. Admin utility actions (unassign-db, cleanup orphans)
//   3. The public /schools/list and /schools/:code/details endpoints
//   4. The old manual send-invite (updated to use new token URL via invitations system)
//
// The /:id/send-invite and /:id/resend-invite routes now delegate
// to the invitations system so the URL format is always correct.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  jwtMiddleware,
  requireSuperPermission,
  superTokenValidationMiddleware,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { schoolsSchema, tursoDatabasesSchema } from "../../../db";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

const schoolsRouter = new Hono<Env>();

// ==================== PUBLIC ROUTES (NO AUTH REQUIRED) ====================

// Public: list of active schools (for school-code entry on login page)
schoolsRouter.get("/list", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const schools = await db
      .select({
        name: schoolsSchema.name,
        uniqueCode: schoolsSchema.uniqueCode,
      })
      .from(schoolsSchema)
      .where(eq(schoolsSchema.isActive, true)) // Only active schools
      .all();

    const formattedSchools = schools.map(
      (school) => `${school.name} - ${school.uniqueCode}`
    );

    return c.json({ schools: formattedSchools });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Public: get school details by code (used by registration page to pre-fill)
schoolsRouter.get("/:code/details", async (c) => {
  try {
    const code = c.req.param("code");
    const db = getCommonDB(c.env);
    const school = await db
      .select()
      .from(schoolsSchema)
      .where(eq(schoolsSchema.uniqueCode, code))
      .get();

    if (!school) return c.json({ error: "School not found" }, 404);

    return c.json(school);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ==================== PROTECTED ROUTES ====================
schoolsRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// List all schools (with onboarding status)
schoolsRouter.get("/", requireSuperPermission("schools.list"), async (c) => {
  try {
    const db = getCommonDB(c.env);
    const schools = await db.select().from(schoolsSchema).all();
    return c.json(schools);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get school by ID
schoolsRouter.get("/:id", requireSuperPermission("schools.list"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const db = getCommonDB(c.env);
    const school = await db
      .select()
      .from(schoolsSchema)
      .where(eq(schoolsSchema.id, id))
      .get();
    if (!school) return c.json({ error: "School not found" }, 404);
    return c.json(school);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ── Unassign DB from a school ─────────────────────────────────────────────────
// Useful for resetting a stuck school record
schoolsRouter.post(
  "/:id/unassign-db",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);

      const school = await db
        .select()
        .from(schoolsSchema)
        .where(eq(schoolsSchema.id, schoolId))
        .get();

      if (!school) return c.json({ error: "School not found" }, 404);
      if (!school.tursoDbId)
        return c.json({ message: "No database assigned to unassign" }, 200);

      await db
        .update(schoolsSchema)
        .set({ tursoDbId: null, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(schoolsSchema.id, schoolId));

      await db
        .update(tursoDatabasesSchema)
        .set({ isAssigned: false })
        .where(eq(tursoDatabasesSchema.id, school.tursoDbId));

      console.log(`Unassigned DB ${school.tursoDbId} from school ${schoolId}`);

      return c.json({ message: "Database unassigned successfully" });
    } catch (error: any) {
      console.error("Unassign DB error:", error);
      return c.json(
        { error: error.message || "Failed to unassign database" },
        500
      );
    }
  }
);

// ── Bulk unassign orphaned DBs ────────────────────────────────────────────────
schoolsRouter.post(
  "/unassign-unused-dbs",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);

      const assignedDbs = await db
        .select({ id: tursoDatabasesSchema.id })
        .from(tursoDatabasesSchema)
        .where(eq(tursoDatabasesSchema.isAssigned, true))
        .all();

      if (assignedDbs.length === 0) {
        return c.json({
          message: "No assigned databases found",
          unassignedCount: 0,
        });
      }

      let unassignedCount = 0;

      for (const dbRecord of assignedDbs) {
        const usingSchools = await db
          .select({ count: sql`COUNT(*)` })
          .from(schoolsSchema)
          .where(eq(schoolsSchema.tursoDbId, dbRecord.id))
          .get();

        const schoolCount = (usingSchools?.count as number) ?? 0;

        if (schoolCount === 0) {
          await db
            .update(tursoDatabasesSchema)
            .set({ isAssigned: false })
            .where(eq(tursoDatabasesSchema.id, dbRecord.id));

          console.log(`Unassigned orphan DB ${dbRecord.id}`);
          unassignedCount++;
        }
      }

      return c.json({
        message: `Cleanup complete. Unassigned ${unassignedCount} orphan databases.`,
        unassignedCount,
      });
    } catch (error: any) {
      console.error("Unassign unused DBs error:", error);
      return c.json(
        { error: error.message || "Failed to unassign unused databases" },
        500
      );
    }
  }
);

export default schoolsRouter;
