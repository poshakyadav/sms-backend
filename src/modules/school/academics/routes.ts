import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";

import {
  activateAcademicYear,
  assignRollNumbers,
  bulkPromoteStudents,
  createAcademicYear,
  deleteAcademicYear,
  enrollStudentInClassSection,
  getAcademicYears,
  getEnrollments,
  getEnrollmentStatus,
  getPermanentlyUnenrolledStudents,
  getTeachers,
  getUnenrolledStudents,
  moveStudentToNewClassSection,
  promoteStudentsToNextYear,
  unenrollStudent,
  updateAcademicYear,
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
  requirePermission("academics.years.manage"),
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
  requirePermission("academics.years.manage"),
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
  requirePermission("academics.years.manage"),
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
  requirePermission("academics.years.manage"),
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

academicsRouter.patch(
  "/years/:id/activate",
  requirePermission("academics.years.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid year ID" }, 400);

      const schoolCode = c.get("schoolCode")!;
      const result = await activateAcademicYear(c.env, schoolCode, id);

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

/**
 * Student Enrollment Routes
 */
// ==================== Enroll Student in Class ====================
const enrollmentSchema = z.object({
  studentId: z.number(),
  classSectionId: z.number(),
  rollNumber: z.string().nullable().optional(),
});

academicsRouter.post(
  "/enroll-student",
  requirePermission("academics.enroll"),
  zValidator("json", enrollmentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await enrollStudentInClassSection(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Enrollments ====================
academicsRouter.get(
  "/enrollments",
  requirePermission("academics.enroll"),
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
  requirePermission("academics.enroll"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const students = await getUnenrolledStudents(c.env, schoolCode);
      return c.json({ students });
    } catch (error: any) {
      console.error("[unenrolled-students route]", error.message);

      // Return structured errors instead of 500 for known conditions
      if (error.message === "NO_ACADEMIC_YEAR") {
        return c.json(
          {
            error: "No active academic year found. Please create and activate an academic year before managing enrollments.",
            code: "NO_ACADEMIC_YEAR",
          },
          404
        );
      }

      return c.json({ error: error.message ?? "Failed to fetch unenrolled students" }, 500);
    }
  }
);

// ==================== Get Permanently Unenrolled Students ====================
// Powers the "Unenrolled Students" tab in Enrollment Management.
// Returns students whose school_users.isActive = false (set by PERMANENT unenrollment)
// along with their last enrollment audit details.
academicsRouter.get(
  "/permanently-unenrolled-students",
  requirePermission("academics.unenroll"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const students = await getPermanentlyUnenrolledStudents(c.env, schoolCode);
      return c.json({ students });
    } catch (error: any) {
      if (error.message === "NO_ACADEMIC_YEAR") {
        return c.json(
          {
            error: "No active academic year found. Please create and activate an academic year before managing enrollments.",
            code: "NO_ACADEMIC_YEAR",
          },
          404
        );
      }
      return c.json({ error: error.message ?? "Failed to fetch data" }, 500);
    }
  }
);

/**
 * STUDENT MOVE / PROMOTE / DEPROMOTE
 */
// ==================== MANUAL SINGLE STUDENT MOVE / PROMOTE / DEPROMOTE ====================
const moveStudentSchema = z.object({
  studentId: z.number().int().positive(),
  targetClassSectionId: z.number().int().positive(),
  targetRollNumber: z.string().nullable().optional(), // null = auto-generate
  notes: z.string().max(200).optional(), // optional remark for history
});

academicsRouter.post(
  "/move-student",
  requirePermission("academics.enroll"),
  zValidator("json", moveStudentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await moveStudentToNewClassSection(
        c.env,
        schoolCode,
        data
      );

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
  requirePermission("academics.years.manage"),
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

/**
 * ROLL NUMBERS
 */
// ==================== Bulk Assign Roll Numbers ====================
const assignRollSchema = z.object({
  classSectionId: z.number().int().positive(),
  orderBy: z.enum(["name", "admissionDate"]).default("name"),
});

academicsRouter.post(
  "/assign-roll-numbers",
  requirePermission("academics.enroll"),
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

// ==================== BULK PROMOTE WITH TARGET ====================
/**
 * Promotes a list of students to a target class-section (or next via mapping).
 *
 * Request:
 * POST /school/academics/promote-bulk
 * {
 *   studentIds: [1, 2, 3],
 *   academicYearId: 5,           // target academic year id
 *   targetClassSectionId: 12,    // explicit target, OR
 *   useMapping: true             // use configured class-section mappings
 * }
 */
const bulkPromoteSchema = z.object({
  studentIds: z.array(z.number().int().positive()).min(1).max(200),
  targetClassSectionId: z.number().int().positive().optional().nullable(),
  useMapping: z.boolean().default(false),
});

academicsRouter.post(
  "/promote-bulk",
  requirePermission("academics.enroll"),
  zValidator("json", bulkPromoteSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      if (!data.targetClassSectionId && !data.useMapping) {
        return c.json(
          {
            error: "Either targetClassSectionId or useMapping must be provided",
          },
          400
        );
      }

      const result = await bulkPromoteStudents(c.env, schoolCode, data);
      return c.json(result, 200);
    } catch (error: any) {
      console.error("Bulk promote error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== GET ENROLLMENT STATUS (Pre-flight check) ====================
/**
 * GET /school/academics/enrollment-status/:studentId
 *
 * Pre-flight check endpoint. The frontend calls this BEFORE showing
 * the unenrollment form. Returns:
 *   - Current enrollment details
 *   - Pending fee summary (warning only, not a hard block)
 *   - Historical record counts (so admin knows what's preserved)
 *
 * Permission: academics.unenroll
 */
academicsRouter.get(
  "/enrollment-status/:studentId",
  requirePermission("academics.unenroll"),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"));
      if (isNaN(studentId) || studentId <= 0) {
        return c.json({ error: "Invalid student ID" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const status = await getEnrollmentStatus(c.env, schoolCode, studentId);

      return c.json({ success: true, ...status });
    } catch (error: any) {
      console.error("Enrollment status error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== UNENROLL STUDENT ====================
/**
 * POST /school/academics/unenroll-student
 *
 * Performs the unenrollment. This is a destructive-ish operation
 * (deactivates user account for PERMANENT type), so it requires:
 *   - academics.unenroll permission (more restrictive than academics.enroll)
 *   - explicit acknowledgment of pending fees if any exist
 *
 * Body:
 * {
 *   studentId: number,
 *   unenrollmentType: "TEMPORARY" | "PERMANENT",
 *   reason: string (min 5 chars, max 500),
 *   acknowledgePendingFees: boolean (required if there are pending fees)
 * }
 */
const unenrollSchema = z.object({
  studentId: z.number().int().positive(),
  unenrollmentType: z.enum(["TEMPORARY", "PERMANENT"]),
  reason: z
    .string()
    .min(5, "Reason must be at least 5 characters")
    .max(500, "Reason cannot exceed 500 characters")
    .trim(),
  acknowledgePendingFees: z.boolean().optional().default(false),
});

academicsRouter.post(
  "/unenroll-student",
  requirePermission("academics.unenroll"),
  zValidator("json", unenrollSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const performingUser = c.get("user")!;

      // ── Pre-flight: check pending fees before allowing unenrollment ──────
      // We do this check server-side too (not just frontend) for security.
      // If there are pending fees AND the admin hasn't acknowledged them,
      // we return a 409 with the fee details so the frontend can show the warning.
      const status = await getEnrollmentStatus(
        c.env,
        schoolCode,
        data.studentId
      );

      if (!status.isEnrolled) {
        return c.json(
          { error: "Student does not have an active enrollment" },
          400
        );
      }

      if (status.pendingFees?.hasPendingFees && !data.acknowledgePendingFees) {
        return c.json(
          {
            error: "Student has pending fees that must be acknowledged",
            requiresAcknowledgment: true,
            pendingFees: status.pendingFees,
          },
          409
        );
      }

      // ── Perform the unenrollment ─────────────────────────────────────────
      const result = await unenrollStudent(c.env, schoolCode, {
        studentId: data.studentId,
        unenrollmentType: data.unenrollmentType,
        reason: data.reason,
        performedBy: performingUser.id,
        acknowledgePendingFees: data.acknowledgePendingFees,
      });

      return c.json(result, 200);
    } catch (error: any) {
      console.error("Unenroll student error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Teachers ====================
academicsRouter.get(
  "/teachers",
  requirePermission("academics.assign-teacher"),
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
