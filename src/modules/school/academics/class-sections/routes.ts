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
  createClassSection,
  deleteClassSection,
  getAvailableClassSectionsForEnrollment,
  getClassSections,
  updateClassSection,
} from "./services";

/** Hard capacity cap — enforced at both API and DB level. */
const MAX_CAPACITY = 50;

const classSectionsRouter = new Hono<SchoolEnv>();

classSectionsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

const classSectionSchema = z.object({
  classId: z.number().int().positive(),
  sectionId: z.number().int().positive(),
  capacity: z.number().int().min(1).max(MAX_CAPACITY).default(40),
  classTeacherId: z.number().int().positive().optional().nullable(),
  roomNumber: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

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

// Available sections for enrollment dropdowns
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

      // Extra guard: reject even partial updates that exceed the cap
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
