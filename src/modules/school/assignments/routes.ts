import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
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
  getStudentOwnAssignments,
} from "./services";

const assignmentsRouter = new Hono<SchoolEnv>();

assignmentsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ==================== STUDENT: View Own Assignments ====================
const studentOwnAssignmentsSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  classSubjectId: z.coerce.number().optional(),
  type: z.enum(["CLASS_WORK", "HOME_WORK", "ASSIGNMENT"]).optional(),
});
 
assignmentsRouter.get(
  "/student/my",
  requirePermission("assignments.student.view"), // ← FIXED: was "assignments.submissions.view"
  zValidator("query", studentOwnAssignmentsSchema),
  async (c) => {
    try {
      const query = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
 
      // studentId always comes from JWT — student cannot query another student's data
      const assignments = await getStudentOwnAssignments(c.env, schoolCode, {
        studentId: user.id,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        classSubjectId: query.classSubjectId,
        type: query.type,
      });
 
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== STUDENT: Mark Assignment as Done ====================
const studentSubmitSchema = z.object({
  assignmentId: z.number(),
});

assignmentsRouter.post(
  "/student/submit",
  requirePermission("assignments.student.submit"), // ← FIXED: was "assignments.submissions.view"
  zValidator("json", studentSubmitSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
 
      const result = await studentSubmitAssignment(
        c.env,
        schoolCode,
        data,
        user.id
      );
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Student submit error:", error.message);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== PARENT: View Child's Assignments ====================
// Child ID is read from X-Active-Child-Id header (injected by auth-interceptor.ts)
const parentAssignmentsQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  classSubjectId: z.coerce.number().optional(),
  type: z.enum(["CLASS_WORK", "HOME_WORK", "ASSIGNMENT"]).optional(),
});
 
assignmentsRouter.get(
  "/parent/child",
  requirePermission("assignments.parent.view"),
  zValidator("query", parentAssignmentsQuerySchema),
  async (c) => {
    try {
      const query = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
 
      // X-Active-Child-Id is set by auth-interceptor.ts from ParentService.activeChildId()
      const activeChildIdHeader = c.req.header("X-Active-Child-Id");
      if (!activeChildIdHeader) {
        return c.json(
          {
            error:
              "No active child selected. Please select a child to view their assignments.",
            requiresChildSelection: true,
          },
          400
        );
      }
 
      const childId = parseInt(activeChildIdHeader, 10);
      if (isNaN(childId) || childId <= 0) {
        return c.json({ error: "Invalid child ID in X-Active-Child-Id header" }, 400);
      }
 
      const assignments = await getStudentOwnAssignments(c.env, schoolCode, {
        studentId: childId,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        classSubjectId: query.classSubjectId,
        type: query.type,
      });
 
      return c.json({ assignments });
    } catch (error: any) {
      console.error("Parent child assignments error:", error.message);
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
  requirePermission("assignments.create"),
  zValidator("json", assignmentSchema, (result, c) => {
    if (!result.success) {
      console.error("Zod Validation Failed:", result.error.message);
      return c.json(
        { error: "Validation Failed", details: result.error.message },
        400
      );
    }
  }),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await createAssignment(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Create Assignment Service Error:", error);
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
  requirePermission("assignments.grade"),
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
assignmentsRouter.get(
  "/:id",
  requirePermission(["assignments.edit", "assignments.create"]),
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
  requirePermission("assignments.create"),
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
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Update Assignment ====================
assignmentsRouter.put(
  "/:id",
  requirePermission("assignments.edit"),
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

// ==================== Delete Assignment ====================
assignmentsRouter.delete(
  "/:id",
  requirePermission("assignments.delete"),
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
  requirePermission("assignments.grade"),
  zValidator("json", submissionSchema, (result, c) => {
    if (!result.success) {
      console.error("Submission Validation Failed:", result.error.message);
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

      const result = await recordSubmission(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Record submission error:", error.message);
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
  requirePermission(["assignments.grade", "assignments.submissions.view"]),
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
