import z from "zod";
import {
  schoolJwtMiddleware,
  schoolPermissionMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolRole } from "../../../../types/school-role";
import { zValidator } from "@hono/zod-validator";
import { createClass, deleteClass, getClasses, updateClass } from "./services";
import { Hono } from "hono";
import { SchoolEnv } from "../../../../types/common-types";

const classesRouter = new Hono<SchoolEnv>();

classesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Class CRUD ====================
const classSchema = z.object({
  name: z.string().min(1).max(50), // "Class 1", "10th"
  level: z.number().int().min(0).max(12), // 0 = Nursery
  sort_order: z.number().int().min(0).max(100), // for sorting
});

classesRouter.post(
  "/classes",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
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
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.TEACHER,
  ]),
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

classesRouter.put(
  "/classes/:id",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
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
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;

      const result = await deleteClass(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default classesRouter;
