// src/modules/school/attendance/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  ALL_ATTENDANCE_STATUSES,
  AttendanceStatus,
  HalfDaySession,
} from "../../../db/schemas/school/school-attendances";
import {
  markAttendance,
  getAttendanceByStudent,
  getAttendanceReport,
  getAttendanceSummaryForParentChild,
  getAttendanceForParentChildView,
  getAttendanceSummaryForStudent,
  getAttendanceByStudentSelf,
  getAttendanceByClassSection,
  getAttendanceAuditLog,
} from "./services";
import { checkCalendarStatus, declareHoliday, getCalendarEntries, getMissingAttendanceReport, getWeeklyOffDays, previewHolidayImpact, removeCalendarOverride, setWeeklyOffDays, setWorkingDayOverride } from "./calendar-service";

// Structural type, not the ZodError class — @hono/zod-validator's hook
// types its error param against Zod v4's core $ZodError. path is
// PropertyKey[] (string | number | symbol) there, not just string | number,
// so this has to match exactly or TS won't narrow it down for us.
interface ZodErrorLike {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}

function formatZodError(error: ZodErrorLike): string {
  const first = error.issues[0];
  if (!first) return "Invalid request data";
  // .map(String) not .join() directly — Array.join() does an implicit
  // ToString on each element, which throws a TypeError at runtime for
  // symbol path segments. String(x) handles symbols safely.
  const path = first.path.map(String).join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

function validateJson<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: formatZodError(result.error) }, 400);
    }
  });
}

function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("query", schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: formatZodError(result.error) }, 400);
    }
  });
}

const attendanceRouter = new Hono<SchoolEnv>();

attendanceRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

// ── Defense in depth: reject HOLIDAY at the validation layer too, not just
//    deep inside markAttendance(). ────────────────────────────────────────
const attendanceStatusEnum = z.enum(ALL_ATTENDANCE_STATUSES).refine(
  (v) => v !== AttendanceStatus.HOLIDAY,
  {
    message:
      "HOLIDAY is not a valid per-student status — declare it on the attendance calendar instead (the calendar endpoints), not per student.",
  }
);

/**
 * Per-student record within a batch mark request.
 * halfDaySession is required when status === HALF_DAY; validated with .superRefine.
 */
const attendanceRecordSchema = z
  .object({
    studentId: z.number().int().positive(),
    status: attendanceStatusEnum,
    halfDaySession: z
      .enum([HalfDaySession.MORNING, HalfDaySession.AFTERNOON])
      .optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.status === AttendanceStatus.HALF_DAY && !val.halfDaySession) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["halfDaySession"],
        message:
          "halfDaySession (MORNING or AFTERNOON) is required when status is HALF_DAY",
      });
    }
    if (val.status !== AttendanceStatus.HALF_DAY && val.halfDaySession) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["halfDaySession"],
        message: "halfDaySession must be omitted when status is not HALF_DAY",
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// POST /school/attendance — Mark Attendance (Batch for a Class-Section)
//
// Permission : attendance.mark
// Used by    : Teachers, Class Teachers, Admin
// Notes      : Uses upsert pattern so corrections are allowed after initial marking.
//              HOLIDAY and ON_DUTY rows can be created here too — the service
//              handles them identically (stores the status, no special logic needed
//              at the route layer).
// ─────────────────────────────────────────────────────────────────────────────
const markAttendanceSchema = z.object({
  date: z.string().date(), // "YYYY-MM-DD"
  classSectionId: z.number().int().positive(),
  attendances: z.array(attendanceRecordSchema).min(1),
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/student — Get Attendance by Student (Staff view)
//
// Permission : attendance.student.view   (staff version — any student)
// Query      : studentId, fromDate, toDate
// ─────────────────────────────────────────────────────────────────────────────
const studentAttendanceSchema = z.object({
  studentId: z.coerce.number().int().positive(),
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


// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/audit — Status change history for one student
// Permission : attendance.report
// ─────────────────────────────────────────────────────────────────────────────
const auditSchema = z.object({
  studentId: z.coerce.number().int().positive(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
});

attendanceRouter.get(
  "/audit",
  requirePermission("attendance.report"),
  zValidator("query", auditSchema),
  async (c) => {
    try {
      const { studentId, fromDate, toDate } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const log = await getAttendanceAuditLog(c.env, schoolCode, studentId, fromDate, toDate);
      return c.json({ log });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);


const classAttendanceSchema = z.object({
  classSectionId: z.coerce.number().int().positive(),
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
 
      const result = await getAttendanceByClassSection(
        c.env,
        schoolCode,
        classSectionId,
        date
      );
 
      // result already has the shape { session, students }
      return c.json(result);
    } catch (error: any) {
      console.error("Get class attendance error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/report — Monthly / Yearly Summary (Staff view)
//
// Permission : attendance.report
// Query      : classSectionId?, month, year
//
// Returns per-student breakdown with all nine status counts + derived
// percentage using the production-grade formula (neutral statuses excluded
// from denominator).
// ─────────────────────────────────────────────────────────────────────────────
const reportSchema = z.object({
  classSectionId: z.coerce.number().int().positive().optional(),
  month: z.coerce.number().min(1).max(12).optional(),
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/me — Student: Own Attendance (date range)
//
// Permission : attendance.student.view
// JWT userId : used directly — no override possible.
// ─────────────────────────────────────────────────────────────────────────────
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
        user.id,
        fromDate,
        toDate
      );
      return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/me/summary — Student: Monthly Summary
//
// Permission : attendance.student.view
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/child — Parent: View Child's Attendance (date range)
//
// Permission : attendance.parent.view
// Security   : parentId from JWT + childStudentId from X-Active-Child-Id header.
//              Parent–child link is verified in the service layer.
// ─────────────────────────────────────────────────────────────────────────────
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
        user.id,
        childStudentId,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/attendance/child/summary — Parent: Child's Monthly Summary
//
// Permission : attendance.parent.view
// ─────────────────────────────────────────────────────────────────────────────
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

// Calendar service routes are in a separate file (calendar-service.ts) to keep this file focused on attendance marking and reporting.

const declareHolidaySchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
  classSectionId: z.number().int().positive().optional(), // omitted = school-wide
  reason: z.string().min(1).max(200),
});

attendanceRouter.post(
  "/calendar/holiday",
  requirePermission("attendance.calendar.manage"),
  zValidator("json", declareHolidaySchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await declareHoliday(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── classSectionId now optional on the working-day schema ──────────────────
const workingDayOverrideSchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
  classSectionId: z.number().int().positive().optional(), // omitted = school-wide declaration
  reason: z.string().max(200).optional(),
});

attendanceRouter.post(
  "/calendar/working-day",
  requirePermission("attendance.calendar.manage"),
  validateJson(workingDayOverrideSchema),  
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await setWorkingDayOverride(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// GET current weekly-off configuration. Read access is scoped to
// attendance.report (same permission used for /calendar entries) rather
// than attendance.calendar.manage, since any staff building a report or
// viewing the calendar legitimately needs to know which days are off.
attendanceRouter.get(
  "/calendar/weekly-off",
  requirePermission("attendance.report"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const weeklyOffDays = await getWeeklyOffDays(c.env, schoolCode);
      return c.json({ weeklyOffDays });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

const weeklyOffSchema = z.object({
  // 0=Sunday ... 6=Saturday. Empty array is valid (no weekly off at all).
  days: z.array(z.number().int().min(0).max(6)).max(7),
});

attendanceRouter.put(
  "/calendar/weekly-off",
  requirePermission("attendance.calendar.manage"),
  zValidator("json", weeklyOffSchema),
  async (c) => {
    try {
      const { days } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await setWeeklyOffDays(c.env, schoolCode, days);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

attendanceRouter.delete(
  "/calendar/:id",
  requirePermission("attendance.calendar.manage"),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;
      const result = await removeCalendarOverride(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);


// ── calendar query now accepts an optional classSectionId filter ───────────
const calendarQuerySchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
  classSectionId: z.coerce.number().int().positive().optional(),
});

attendanceRouter.get(
  "/calendar",
  requirePermission("attendance.report"),
  zValidator("query", calendarQuerySchema),
  async (c) => {
    try {
      const { fromDate, toDate, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const entries = await getCalendarEntries(c.env, schoolCode, fromDate, toDate, classSectionId);
      return c.json({ entries });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /school/attendance/calendar/check — the mark-attendance page's gate.
// Permission: attendance.mark (any teacher who can reach the mark page
// needs to be able to check whether they're allowed to use it).
// ─────────────────────────────────────────────────────────────────────────
const calendarCheckSchema = z.object({
  classSectionId: z.coerce.number().int().positive(),
  date: z.string().date(),
});

attendanceRouter.get(
  "/calendar/check",
  requirePermission("attendance.mark"),
  zValidator("query", calendarCheckSchema),
  async (c) => {
    try {
      const { classSectionId, date } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const result = await checkCalendarStatus(c.env, schoolCode, classSectionId, date);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// GET /school/attendance/calendar/holiday-impact — read-only preview,
// called before declareHoliday so the UI can show a danger dialog first.
// ─────────────────────────────────────────────────────────────────────────
const holidayImpactSchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
  classSectionId: z.coerce.number().int().positive().optional(),
});

attendanceRouter.get(
  "/calendar/holiday-impact",
  requirePermission("attendance.calendar.manage"),
  zValidator("query", holidayImpactSchema),
  async (c) => {
    try {
      const { fromDate, toDate, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const preview = await previewHolidayImpact(c.env, schoolCode, fromDate, toDate, classSectionId);
      return c.json(preview);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);



// ── THE ADMIN DASHBOARD ANSWER TO "did anyone forget to mark attendance" ──
const missingAttendanceSchema = z.object({
  fromDate: z.string().date(),
  toDate: z.string().date(),
  classSectionId: z.coerce.number().int().positive().optional(),
});

attendanceRouter.get(
  "/missing",
  requirePermission("attendance.report"),
  zValidator("query", missingAttendanceSchema),
  async (c) => {
    try {
      const { fromDate, toDate, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const missing = await getMissingAttendanceReport(c.env, schoolCode, fromDate, toDate, classSectionId);
      return c.json({ missing });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default attendanceRouter;
