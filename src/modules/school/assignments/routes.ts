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
  createAssignment,
  getAssignments,
  updateAssignment,
  deleteAssignment,
  recordSubmission,
  getSubmissionsReport,
  studentSubmitAssignment,
  getStudentAssignments,
  getSubmissionsByStudent,
  getAssignmentById,
} from "./services";

const assignmentsRouter = new Hono<SchoolEnv>();

assignmentsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ==================== Get Student Assignments (With filters) ====================
// ==================== Get Student Assignments ====================
const studentAssignmentsSchema = z.object({
  studentId: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  classSubjectId: z.coerce.number().optional(),
});

assignmentsRouter.get(
  "/student",
  schoolPermissionMiddleware([SchoolRole.STUDENT, SchoolRole.STUDENT_PARENT]),
  zValidator("query", studentAssignmentsSchema),
  async (c) => {
    try {
      const query = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      let effectiveStudentId = user.role === SchoolRole.STUDENT ? user.id : query.studentId;
      if (!effectiveStudentId) throw new Error("Student ID required");

      const assignments = await getStudentAssignments(c.env, schoolCode, {
        studentId: effectiveStudentId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        classSubjectId: query.classSubjectId,
      });

      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Student Mark as Done ====================
const studentSubmitSchema = z.object({
  assignmentId: z.number(),
});

assignmentsRouter.post(
  "/submit",
  schoolPermissionMiddleware([SchoolRole.STUDENT]),
  zValidator("json", studentSubmitSchema),
  async (c) => {
    try {
      console.log("🔄 Student submitting assignment...");
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await studentSubmitAssignment(
        c.env,
        schoolCode,
        data, // now only { assignmentId }
        user.id
      );
      console.log("✅ Student marked as done successfully");
      return c.json(result, 201);
    } catch (error: any) {
      console.error("❌ Student submit error:", error.message);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Assignment CRUD ====================
const assignmentSchema = z.object({
  teacherAssignmentId: z.number(),
  classSectionId: z.number(),
  type: z.enum(["CLASS_WORK", "HOME_WORK", "ASSIGNMENT"]),
  title: z.string().min(3),
  description: z.string().min(10),
  dueDate: z.string().date().optional().nullable(),
  targetDate: z.string().date().optional().nullable(),
  maxMarks: z.number().positive().optional().nullable(),
  isMandatory: z.boolean().default(true),
});

assignmentsRouter.post(
  "/",
  schoolPermissionMiddleware([SchoolRole.TEACHER]),
  zValidator("json", assignmentSchema, (result, c) => {
    if (!result.success) {
      console.error("❌ Zod Validation Failed:", result.error.message);
      return c.json(
        {
          error: "Validation Failed",
          details: result.error.message,
        },
        400
      );
    }
  }),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      console.log("✅ Validation Passed. Creating assignment...");
      const result = await createAssignment(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("🔥 Create Assignment Service Error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get Submissions Report ====================
const reportSchema = z.object({
  classSectionId: z.number().optional(),
  assignmentId: z.coerce.number(),
});

assignmentsRouter.get(
  "/report",
  schoolPermissionMiddleware([
    SchoolRole.TEACHER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
  zValidator("query", reportSchema),
  async (c) => {
    try {
      const data = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const report = await getSubmissionsReport(c.env, schoolCode, data);
      return c.json({ report });
    } catch (error: any) {
      console.error("Submissions report error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Single Assignment (for Edit) ====================
// This must come AFTER /report
assignmentsRouter.get(
  "/:id",
  schoolPermissionMiddleware([
    SchoolRole.TEACHER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.SCHOOL_OWNER,
  ]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;

      const assignment = await getAssignmentById(c.env, schoolCode, id);
      return c.json({ assignment });
    } catch (error: any) {
      console.error("Get assignment by ID error:", error);
      return c.json(
        { error: error.message },
        error.message.includes("not found") ? 404 : 500
      );
    }
  }
);

// ==================== Staff Assignments (Enhanced with filters) ====================
assignmentsRouter.get(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.TEACHER,
  ]),
  zValidator(
    "query",
    z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      classSubjectId: z.coerce.number().optional(),
      classSectionId: z.coerce.number().optional(),
      teacherId: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
    })
  ),
  async (c) => {
    try {
      const filters = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const assignments = await getAssignments(c.env, schoolCode, filters);

      console.log("Fetched assignments with filters:", filters, assignments);
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

assignmentsRouter.put(
  "/:id",
  schoolPermissionMiddleware([SchoolRole.TEACHER, SchoolRole.PRINCIPAL]),
  zValidator("json", assignmentSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await updateAssignment(c.env, schoolCode, id, data);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

assignmentsRouter.delete(
  "/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;

      const result = await deleteAssignment(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Record Submission/Marks (Batch) ====================
const submissionSchema = z.object({
  assignmentId: z.number(),
  submissions: z.array(
    z.object({
      enrollmentId: z.number(),
      teacherStatus: z.enum(["NOT_RECEIVED", "RECEIVED", "GRADED"]),
      marksObtained: z.number().optional().nullable(),
      remarks: z.string().optional().default(""),
      // studentStatus is optional (we don't let teacher change it here)
      studentStatus: z.enum(["PENDING", "MARKED_AS_DONE"]).optional(),
    })
  ),
});

assignmentsRouter.post(
  "/submissions",
  schoolPermissionMiddleware([SchoolRole.TEACHER, SchoolRole.PRINCIPAL]),
  zValidator("json", submissionSchema, (result, c) => {
    if (!result.success) {
      console.error("❌ Submission Validation Failed:", result.error.message);
      return c.json(
        { error: "Invalid submission data", details: result.error.message },
        400
      );
    }
  }),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      console.log(
        `🔄 Saving ${data.submissions.length} submissions for assignment ${data.assignmentId}`
      );

      const result = await recordSubmission(c.env, schoolCode, data, user.id);

      console.log("✅ Submissions saved successfully");
      return c.json(result, 201);
    } catch (error: any) {
      console.error("❌ Record submission error:", error.message);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Submissions by Student ====================
const studentSubmissionsSchema = z.object({
  studentId: z.number(),
  assignmentId: z.number().optional(),
});

assignmentsRouter.get(
  "/submissions/student",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.TEACHER,
    SchoolRole.STUDENT,
    SchoolRole.STUDENT_PARENT,
  ]),
  zValidator("query", studentSubmissionsSchema),
  async (c) => {
    try {
      const { studentId, assignmentId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const submissions = await getSubmissionsByStudent(
        c.env,
        schoolCode,
        studentId,
        assignmentId
      );

      return c.json({ submissions });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

export default assignmentsRouter;
