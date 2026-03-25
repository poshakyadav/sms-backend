import { Hono } from "hono";
import {
  schoolJwtMiddleware,
  schoolPermissionMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import { getStudents } from "./services";

const studentsRouter = new Hono<SchoolEnv>();

studentsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Get Students ====================
studentsRouter.get(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ADMISSION_OFFICER,
    SchoolRole.TEACHER, // Optional: Allow teachers to view for attendance/etc.
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const students = await getStudents(c.env, schoolCode);

      return c.json({ students });
    } catch (error: any) {
      console.error("Students fetch error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

export default studentsRouter;
