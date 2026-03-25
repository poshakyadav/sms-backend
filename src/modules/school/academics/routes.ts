import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
  schoolPermissionMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

import {
  createAcademicYear,
  getAcademicYears,
  updateAcademicYear,
  deleteAcademicYear,
  promoteStudentsToNextYear,
  enrollStudentInClass,
  getEnrollments,
  assignRollNumbers,
  getUnenrolledStudents,
  getTeachers,
  moveStudentToNewClassSection,
} from "./services";

const academicsRouter = new Hono<SchoolEnv>();

academicsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Academic Year CRUD ====================
const academicYearSchema = z.object({
  name: z
    .string()
    .min(9)
    .max(9)
    .regex(/^\d{4}-\d{4}$/), // "2025-2026"
  startDate: z.string().date(), // "2025-04-01"
  endDate: z.string().date(),
});

academicsRouter.post(
  "/years",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", academicYearSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await createAcademicYear(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      console.error(error);
      return c.json({ error: error.message }, 400);
    }
  }
);

academicsRouter.get(
  "/years",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const years = await getAcademicYears(c.env, schoolCode);

      return c.json({ years });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

academicsRouter.put(
  "/years/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", academicYearSchema.partial()), // Partial for updates
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await updateAcademicYear(c.env, schoolCode, id, data);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

academicsRouter.delete(
  "/years/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;

      const result = await deleteAcademicYear(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);


/**
 * How to Use This Feature
 * Request (Depromote):
 * POST /move-student
  {
    "studentId": 123,
    "targetClassSectionId": 8,     // lower class
    "targetRollNumber": null,
    "notes": "Parent request - weak in studies"
  }
 * 
 * Response (UI-friendly):
 * {
    "message": "Student moved successfully",
    "studentName": "Rahul Sharma",
    "oldClassSectionId": 12,
    "oldRollNumber": "023",
    "newEnrollment": { ...full details... },
    "notes": "Parent request - weak in studies"
  }
 * 
 * 
 */
// ==================== MANUAL SINGLE STUDENT MOVE / PROMOTE / DEPROMOTE ====================
const moveStudentSchema = z.object({
  studentId: z.number().int().positive(),
  targetClassSectionId: z.number().int().positive(),
  targetRollNumber: z.string().nullable().optional(),   // null = auto-generate
  notes: z.string().max(200).optional(),                // optional remark for history
});

academicsRouter.post(
  "/move-student",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ADMISSION_OFFICER,
  ]),
  zValidator("json", moveStudentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await moveStudentToNewClassSection(c.env, schoolCode, data);

      return c.json(result, 200);
    } catch (error: any) {
      console.error("Student move error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Student Promotion (Batch Process) ====================
academicsRouter.post(
  "/promote-students",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const result = await promoteStudentsToNextYear(c.env, schoolCode);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Enroll Student in Class ====================
const enrollmentSchema = z.object({
  studentId: z.number(),
  classSectionId: z.number(),
  rollNumber: z.string().nullable().optional(),
});

academicsRouter.post(
  "/enroll-student",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ADMISSION_OFFICER,
  ]),
  zValidator("json", enrollmentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await enrollStudentInClass(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Enrollments ====================
academicsRouter.get(
  "/enrollments",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ACCOUNTANT, // For fees
    SchoolRole.ADMISSION_OFFICER,
    SchoolRole.TEACHER,
    SchoolRole.STUDENT,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const enrollments = await getEnrollments(c.env, schoolCode);

      return c.json({ enrollments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get Unenrolled Students ====================
academicsRouter.get(
  "/unenrolled-students",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ADMISSION_OFFICER,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const students = await getUnenrolledStudents(c.env, schoolCode);
      return c.json({ students });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Bulk Assign Roll Numbers ====================
const assignRollSchema = z.object({
  classId: z.number(),
  sectionId: z.number(),
  orderBy: z.enum(["name", "admissionDate"]).default("name"),
});

academicsRouter.post(
  "/assign-roll-numbers",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", assignRollSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await assignRollNumbers(c.env, schoolCode, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Teachers ====================
academicsRouter.get(
  "/teachers",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.TEACHER,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const teachers = await getTeachers(c.env, schoolCode); // From services
      return c.json({ teachers });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

export default academicsRouter;
