import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import { getStudentById, getStudents, getStudentsByClassSection } from "./services";
import bulkUploadRouter from "./bulk-upload/routes";

const studentsRouter = new Hono<SchoolEnv>();

studentsRouter.route("/bulk-upload", bulkUploadRouter);

studentsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

/**
 * GET /school/students
 *
 * "students.list" is seeded for SCHOOL_OWNER, PRINCIPAL, MANAGER,
 * ADMISSION_OFFICER, and TEACHER. Students and parents do NOT
 * have this permission — they use "students.view.own".
 */

studentsRouter.get(
  "/",
  requirePermission("students.list"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const students = await getStudents(c.env, schoolCode);

      return c.json({ success: true, students });
    } catch (error: any) {
      console.error("Students fetch error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// GET /school/students/by-class-section?classSectionId=X
studentsRouter.get(
  "/by-class-section",
  requirePermission("students.list"),
  async (c) => {
    try {
      const classSectionId = parseInt(c.req.query("classSectionId") || "0");
      if (!classSectionId) {
        return c.json({ error: "classSectionId is required" }, 400);
      }
      const schoolCode = c.get("schoolCode")!;
      const students = await getStudentsByClassSection(c.env, schoolCode, classSectionId);
      return c.json({ students });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

/**
 * GET /school/students/:id
 *
 * Staff with "students.list" can view any student.
 * A student with "students.view.own" can view only themselves.
 */
studentsRouter.get("/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) {
      return c.json({ success: false, error: "Invalid student ID" }, 400);
    }
 
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;
    const userPermissions = user.permissions;
 
    const canViewAll = userPermissions.includes("students.list");
    const canViewOwn = userPermissions.includes("students.view.own");
 
    if (!canViewAll && !canViewOwn) {
      return c.json({ success: false, error: "Forbidden: Insufficient permissions" }, 403);
    }
 
    // "students.view.own" users can only view themselves
    if (!canViewAll && canViewOwn && id !== user.id) {
      return c.json(
        { success: false, error: "Forbidden: You can only view your own profile" },
        403
      );
    }
 
    const student = await getStudentById(c.env, schoolCode, id);
 
    if (!student) {
      return c.json({ success: false, error: "Student not found" }, 404);
    }
 
    return c.json({ success: true, student });
  } catch (error: any) {
    console.error("Student fetch error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default studentsRouter;
