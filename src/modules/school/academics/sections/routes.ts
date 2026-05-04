import z from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolRole } from "../../../../types/school-role";
import { zValidator } from "@hono/zod-validator";
import {
  createSection,
  deleteSection,
  getSections,
  updateSection,
} from "./services";
import { Hono } from "hono";
import { SchoolEnv } from "../../../../types/common-types";

const sectionsRouter = new Hono<SchoolEnv>();

sectionsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Section CRUD ====================
const sectionSchema = z.object({
  name: z.string().min(1).max(50), // "A", "Science"
});

sectionsRouter.post(
  "/sections",
  requirePermission("academics.sections.manage"),
  zValidator("json", sectionSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await createSection(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      console.error("Section creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

sectionsRouter.get(
  "/sections",
  requirePermission("academics.sections.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const sections = await getSections(c.env, schoolCode);

      return c.json({ sections });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

sectionsRouter.put(
  "/sections/:id",
  requirePermission("academics.sections.manage"),
  zValidator("json", sectionSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await updateSection(c.env, schoolCode, id, data);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

sectionsRouter.delete(
  "/sections/:id",
  requirePermission("academics.sections.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;

      const result = await deleteSection(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default sectionsRouter;
