// …/school/academics/classes/routes.ts

import z from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { zValidator } from "@hono/zod-validator";
import {
  createClass,
  deleteClass,
  getClasses,
  updateClass,
  bulkCreateClasses,
  bulkUpdateClasses,
} from "./services";
import { Hono } from "hono";
import { SchoolEnv } from "../../../../types/common-types";

const classesRouter = new Hono<SchoolEnv>();

classesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Shared Schemas ====================

const classSchema = z.object({
  name: z.string().min(1).max(50),
  level: z.coerce.number().int().min(0).max(15),
  sort_order: z.coerce.number().int().min(0).max(100),
});

// ── Single item in bulk-create payload ───────────────────────────────────────
const bulkCreateItemSchema = z.object({
  name: z.string().min(1).max(50),
  level: z.coerce.number().int().min(0).max(15),
  sort_order: z.coerce.number().int().min(0).max(100),
});

// ── Single item in bulk-update payload ───────────────────────────────────────
const bulkUpdateItemSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().min(1).max(50).optional(),
  level: z.coerce.number().int().min(0).max(15).optional(),
  sort_order: z.coerce.number().int().min(0).max(100).optional(),
});

// ── Bulk create payload ───────────────────────────────────────────────────────
const bulkCreateSchema = z.object({
  classes: z
    .array(bulkCreateItemSchema)
    .min(1, "At least one class is required")
    .max(50, "Cannot create more than 50 classes at once"),
});

// ── Bulk update payload ───────────────────────────────────────────────────────
const bulkUpdateSchema = z.object({
  classes: z
    .array(bulkUpdateItemSchema)
    .min(1, "At least one class is required")
    .max(50, "Cannot update more than 50 classes at once"),
});

// ==================== Single Class CRUD ====================

classesRouter.post(
  "/classes",
  requirePermission("academics.classes.manage"),
  zValidator("json", classSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createClass(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Class creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

classesRouter.get(
  "/classes",
  requirePermission("academics.classes.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const classes = await getClasses(c.env, schoolCode);
      return c.json({ classes });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Bulk Create ====================
/**
 * POST /school/academics/classes/bulk
 *
 * Creates multiple classes in a single transaction.
 * Skips (or errors) if any name already exists.
 * Returns: { classes: CreatedClass[], skipped: string[], message: string }
 */
classesRouter.post(
  "/classes/bulk",
  requirePermission("academics.classes.manage"),
  zValidator("json", bulkCreateSchema),
  async (c) => {
    try {
      const { classes } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkCreateClasses(c.env, schoolCode, classes);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Bulk class creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Bulk Update ====================
/**
 * PUT /school/academics/classes/bulk
 *
 * Updates multiple classes in a single transaction.
 * Each item must include its id plus the fields to patch.
 * Returns: { classes: UpdatedClass[], notFound: number[], message: string }
 */
classesRouter.put(
  "/classes/bulk",
  requirePermission("academics.classes.manage"),
  zValidator("json", bulkUpdateSchema),
  async (c) => {
    try {
      const { classes } = c.req.valid("json");
      console.log("[BulkUpdate] Received classes:", JSON.stringify(classes));
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkUpdateClasses(c.env, schoolCode, classes);
      return c.json(result);
    } catch (error: any) {
      console.error("Bulk class update error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

classesRouter.put(
  "/classes/:id",
  requirePermission("academics.classes.manage"),
  zValidator("json", classSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateClass(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

classesRouter.delete(
  "/classes/:id",
  requirePermission("academics.classes.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await deleteClass(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default classesRouter;
