import z from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolRole } from "../../../../types/school-role";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { SchoolEnv } from "../../../../types/common-types";
import {
  createBulkMappings,
  createNextMapping,
  deleteMapping,
  getClassSectionMappings,
  updateMapping,
} from "./services";

const classSectionMappingsRouter = new Hono<SchoolEnv>();

classSectionMappingsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ==================== Class-Section Mappings CRUD ====================

/**
 * Goal: Allow admin to define "what is the next class-section for each current class-section"
 * (e.g. Class 1-A → Class 2-A, Class 10-Com → Class 11-Com, Nursery-A → LKG-A, etc.)
 *
 * =======
 * Global (reusable): send without academicYearId
 * Year-specific: send with academicYearId
 */
/**
 * How "Create Once & Reuse Every Year" Now Works
 * - Create a global mapping → omit academicYearId (or send null).
 * Example: 1-A → 2-A
 * This mapping will be used every year automatically.
 *
 * - Create a year-specific mapping → send academicYearId.
 * This overrides the global one only for that year.
 *
 * - During promotion → the code first looks for year-specific, then global, then falls back to same section.
 */
// Example: POST /class-section-mappings
// ==================== Schema (Fixed typo + bulk support) ====================

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * academicYearId rules:
 *   - omitted / null  → GLOBAL mapping (reused every year)
 *   - positive int    → year-specific mapping
 */
const singleMappingSchema = z.object({
  currentClassSectionId: z.number().int().positive(),
  nextClassSectionId: z.number().int().positive(),
  academicYearId: z.number().int().positive().optional().nullable(),
});

const bulkMappingSchema = z
  .array(singleMappingSchema)
  .min(1, "At least one mapping is required")
  .max(200, "Cannot bulk-create more than 200 mappings at once");

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL  —  with optional ?scope=global | ?scope=year&yearId=N
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /school/academics/mappings
 *
 * Query params:
 *   ?scope=all            → all mappings (default)
 *   ?scope=global         → only global (no year) mappings
 *   ?scope=year&yearId=N  → only mappings for academic year N
 */
classSectionMappingsRouter.get(
  "/",
  requirePermission("academics.mappings.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const scopeParam = c.req.query("scope") ?? "all";
      const yearIdParam = c.req.query("yearId");

      let scope: "global" | "all" | number = "all";

      if (scopeParam === "global") {
        scope = "global";
      } else if (scopeParam === "year" && yearIdParam) {
        const yearId = parseInt(yearIdParam);
        if (isNaN(yearId)) {
          return c.json({ error: "yearId must be a valid integer" }, 400);
        }
        scope = yearId;
      }

      const mappings = await getClassSectionMappings(c.env, schoolCode, scope);
      return c.json({ mappings, scope: scopeParam });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CREATE SINGLE
// ─────────────────────────────────────────────────────────────────────────────
classSectionMappingsRouter.post(
  "/",
  requirePermission("academics.mappings.manage"),
  zValidator("json", singleMappingSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createNextMapping(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// BULK CREATE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /school/academics/mappings/bulk
 *
 * Body: array of mapping objects.
 * Each item may have academicYearId = null (global) or a year ID.
 *
 * Example:
 * [
 *   { "currentClassSectionId": 1, "nextClassSectionId": 3 },            // global
 *   { "currentClassSectionId": 2, "nextClassSectionId": 4, "academicYearId": 5 } // year-specific
 * ]
 */
/**
 * How to Use Bulk Create (UI-Friendly)
 * Request:
 * POST /class-section-mappings/bulk
    [
    { "currentClassSectionId": 10, "nextClassSectionId": 15 },
    { "currentClassSectionId": 30, "nextClassSectionId": 35, "academicYearId": 5 }
    ]
 * 
 * Response (UI-friendly):
 * {
    "message": "Successfully created 2 mappings",
    "created": 2,
    "mappings": [
        {
        "id": 45,
        "currentDisplayName": "Class 1 - A",
        "nextDisplayName": "Class 2 - A",
        "isGlobal": true,
        ...
        }
    ]
    }
 */
// ==================== BULK CREATE (New) ====================
classSectionMappingsRouter.post(
  "/bulk",
  requirePermission("academics.mappings.manage"),
  zValidator("json", bulkMappingSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createBulkMappings(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PUT /school/academics/mappings/:id
 *
 * To convert a year-specific mapping to global, send academicYearId: null.
 * To convert a global mapping to year-specific, send the target yearId.
 */
classSectionMappingsRouter.put(
  "/:id",
  requirePermission("academics.mappings.manage"),
  zValidator("json", singleMappingSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid mapping ID" }, 400);
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateMapping(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────
classSectionMappingsRouter.delete(
  "/:id",
  requirePermission("academics.mappings.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid mapping ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await deleteMapping(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default classSectionMappingsRouter;
