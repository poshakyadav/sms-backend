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
  markAttendance,
  getAttendanceByStudent,
  getAttendanceByClass,
  getAttendanceReport,
  getAttendanceSummaryForParentChild,
  getAttendanceForParentChildView,
  getAttendanceSummaryForStudent,
  getAttendanceByStudentSelf,
} from "./services";

const attendanceRouter = new Hono<SchoolEnv>();

attendanceRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Mark Attendance (Batch for Class/Section) ====================
const markAttendanceSchema = z.object({
  date: z.string().date(), // "2026-02-14"
  classSectionId: z.number(),
  attendances: z.array(
    z.object({
      studentId: z.number(),
      status: z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY"]),
      notes: z.string().optional(),
    })
  ),
});

attendanceRouter.post(
  "/",
  requirePermission("attendance.mark"),
  zValidator("json", markAttendanceSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const result = await markAttendance(c.env, schoolCode, data, user.id);

      return c.json(result, 201);
    } catch (error: any) {
      console.error("Attendance marking error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance by Student ====================
const studentAttendanceSchema = z.object({
  studentId: z.coerce.number(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
});

attendanceRouter.get(
  "/student",
  requirePermission("attendance.student.view"),
  zValidator("query", studentAttendanceSchema),
  async (c) => {
    try {
      const { studentId, fromDate, toDate } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const attendance = await getAttendanceByStudent(
        c.env,
        schoolCode,
        studentId,
        fromDate,
        toDate
      );

      return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance by Class/Section/Date ====================
const classAttendanceSchema = z.object({
  classSectionId: z.coerce.number(),
  date: z.string().date(),
});

attendanceRouter.get(
  "/class",
  requirePermission("attendance.mark"),
  zValidator("query", classAttendanceSchema),
  async (c) => {
    try {
      const { classSectionId, date } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const attendance = await getAttendanceByClass(
        c.env,
        schoolCode,
        classSectionId,
        date
      );
      return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance Report (Monthly/Yearly Summary) ====================
const reportSchema = z.object({
  classSectionId: z.coerce.number().optional(),
  // studentId: z.coerce.number().optional(),
  month: z.coerce.number().min(1).max(12).optional(), // For monthly report
  year: z.coerce.number().min(2000).max(2100).optional(),
});

attendanceRouter.get(
  "/report",
  requirePermission("attendance.report"),
  zValidator("query", reportSchema),
  async (c) => {
    try {
      const data = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      console.log("Generating attendance report with params:", data);

      const report = await getAttendanceReport(c.env, schoolCode, data);

      return c.json({ report });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== STUDENT: View Own Attendance (date range) ====================
const studentSelfAttendanceSchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
});

attendanceRouter.get(
  "/me",
  requirePermission("attendance.student.view"),
  zValidator("query", studentSelfAttendanceSchema),
  async (c) => {
    try {
      const { fromDate, toDate } = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const attendance = await getAttendanceByStudentSelf(
        c.env,
        schoolCode,
        user.id, // JWT userId — authoritative
        fromDate,
        toDate
      );

      return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== STUDENT: Monthly Summary ====================
const studentSummarySchema = z.object({
  month: z.coerce.number().min(1).max(12),
  year: z.coerce.number().min(2000).max(2100),
});

attendanceRouter.get(
  "/me/summary",
  requirePermission("attendance.student.view"),
  zValidator("query", studentSummarySchema),
  async (c) => {
    try {
      const { month, year } = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const summary = await getAttendanceSummaryForStudent(
        c.env,
        schoolCode,
        user.id,
        month,
        year
      );

      return c.json({ summary });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== PARENT: View Child's Attendance (date range) ====================
const parentChildAttendanceSchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
});

attendanceRouter.get(
  "/child",
  requirePermission("attendance.parent.view"),
  zValidator("query", parentChildAttendanceSchema),
  async (c) => {
    try {
      const { fromDate, toDate } = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      // X-Active-Child-Id is injected by the frontend auth-interceptor for STUDENT_PARENT role
      const activeChildIdHeader = c.req.header("X-Active-Child-Id");
      if (!activeChildIdHeader) {
        return c.json({ error: "No active child selected" }, 400);
      }
      const childStudentId = parseInt(activeChildIdHeader, 10);
      if (isNaN(childStudentId)) {
        return c.json({ error: "Invalid child ID" }, 400);
      }

      const attendance = await getAttendanceForParentChildView(
        c.env,
        schoolCode,
        user.id, // parentUserId from JWT
        childStudentId, // from X-Active-Child-Id (security-verified in service)
        fromDate,
        toDate
      );

      return c.json({ attendance });
    } catch (error: any) {
      const status = error.message?.includes("Unauthorized") ? 403 : 400;
      return c.json({ error: error.message }, status);
    }
  }
);

// ==================== PARENT: Child's Monthly Summary ====================
const parentSummarySchema = z.object({
  month: z.coerce.number().min(1).max(12),
  year: z.coerce.number().min(2000).max(2100),
});

attendanceRouter.get(
  "/child/summary",
  requirePermission("attendance.parent.view"),
  zValidator("query", parentSummarySchema),
  async (c) => {
    try {
      const { month, year } = c.req.valid("query");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const activeChildIdHeader = c.req.header("X-Active-Child-Id");
      if (!activeChildIdHeader) {
        return c.json({ error: "No active child selected" }, 400);
      }
      const childStudentId = parseInt(activeChildIdHeader, 10);
      if (isNaN(childStudentId)) {
        return c.json({ error: "Invalid child ID" }, 400);
      }

      const summary = await getAttendanceSummaryForParentChild(
        c.env,
        schoolCode,
        user.id,
        childStudentId,
        month,
        year
      );

      return c.json({ summary });
    } catch (error: any) {
      const status = error.message?.includes("Unauthorized") ? 403 : 400;
      return c.json({ error: error.message }, status);
    }
  }
);

export default attendanceRouter;
