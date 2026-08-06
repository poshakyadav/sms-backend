// …/school/academics/class-sections/routes.ts  

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolEnv } from "../../../../types/common-types";
import {
  bulkCreateClassSections,
  bulkUpdateClassSections,
  createClassSection,
  deleteClassSection,
  getAvailableClassSectionsForEnrollment,
  getClassSections,
  updateClassSection,
} from "./services";

/** Hard capacity cap — enforced at both API and DB level. */
const MAX_CAPACITY = 100;

const classSectionsRouter = new Hono<SchoolEnv>();

classSectionsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ── Single row schema ────────────────────────────────────────────────────────
const classSectionSchema = z.object({
  classId: z.number().int().positive(),
  sectionId: z.number().int().positive(),
  capacity: z.number().int().min(1).max(MAX_CAPACITY).default(40),
  classTeacherId: z.number().int().positive().optional().nullable(),
  roomNumber: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

// ── Bulk-create schema ────────────────────────────────────────────────────────
const bulkCreateSchema = z.object({
  rows: z
    .array(
      z.object({
        classId: z.number().int().positive(),
        sectionId: z.number().int().positive(),
        capacity: z.number().int().min(1).max(MAX_CAPACITY).default(40),
        classTeacherId: z.number().int().positive().optional().nullable(),
        roomNumber: z.string().optional().nullable(),
        isActive: z.boolean().default(true),
      })
    )
    .min(1, "At least one row is required")
    .max(200, "Cannot create more than 200 class-sections at once"),
});

// ── Bulk-update schema ────────────────────────────────────────────────────────
const bulkUpdateSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        classId: z.number().int().positive().optional(),
        sectionId: z.number().int().positive().optional(),
        capacity: z.number().int().min(1).max(MAX_CAPACITY).optional(),
        classTeacherId: z.number().int().positive().optional().nullable(),
        roomNumber: z.string().optional().nullable(),
        isActive: z.boolean().optional(),
      })
    )
    .min(1, "At least one item is required")
    .max(200, "Cannot update more than 200 class-sections at once"),
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Literal paths (/bulk-create, /bulk-update) MUST be registered
// BEFORE param paths (/:id) to avoid the router matching "bulk-create" as an ID.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /class-sections/bulk-create ─────────────────────────────────────────
classSectionsRouter.post(
  "/class-sections/bulk-create",
  requirePermission("academics.sections.manage"),
  zValidator("json", bulkCreateSchema),
  async (c) => {
    try {
      const { rows } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkCreateClassSections(c.env, schoolCode, rows);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Bulk class-section creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── PUT /class-sections/bulk-update ──────────────────────────────────────────
classSectionsRouter.put(
  "/class-sections/bulk-update",
  requirePermission("academics.sections.manage"),
  zValidator("json", bulkUpdateSchema),
  async (c) => {
    try {
      const { items } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkUpdateClassSections(c.env, schoolCode, items);
      return c.json(result);
    } catch (error: any) {
      console.error("Bulk class-section update error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── POST /class-sections (single) ─────────────────────────────────────────────
classSectionsRouter.post(
  "/class-sections",
  requirePermission("academics.sections.manage"),
  zValidator("json", classSectionSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createClassSection(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Class-section creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── GET /class-sections ───────────────────────────────────────────────────────
classSectionsRouter.get(
  "/class-sections",
  requirePermission("academics.sections.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const sections = await getClassSections(c.env, schoolCode);
      return c.json({ classSections: sections });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── GET /class-sections/available ────────────────────────────────────────────
classSectionsRouter.get(
  "/class-sections/available",
  requirePermission("academics.enroll"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const sections = await getAvailableClassSectionsForEnrollment(
        c.env,
        schoolCode
      );
      return c.json({ available: sections });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── PUT /class-sections/:id (single) ─────────────────────────────────────────
const updateClassSectionSchema = classSectionSchema.partial();

classSectionsRouter.put(
  "/class-sections/:id",
  requirePermission("academics.sections.manage"),
  zValidator("json", updateClassSectionSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      if (data.capacity !== undefined && data.capacity > MAX_CAPACITY) {
        return c.json(
          {
            error: `Capacity cannot exceed ${MAX_CAPACITY} students per section`,
          },
          400
        );
      }

      const result = await updateClassSection(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── DELETE /class-sections/:id ────────────────────────────────────────────────
classSectionsRouter.delete(
  "/class-sections/:id",
  requirePermission("academics.sections.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await deleteClassSection(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default classSectionsRouter;
