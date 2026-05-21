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
} from "./services";

const attendanceRouter = new Hono<SchoolEnv>();

attendanceRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod enum built directly from the canonical status tuple.
 * Adding a new status to AttendanceStatus auto-expands this validator —
 * no need to update routes separately.
 */
const attendanceStatusEnum = z.enum(ALL_ATTENDANCE_STATUSES);

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
// GET /school/attendance/class — Full Class Sheet for a Date (Teacher view)
//
// Permission : attendance.mark
// Query      : classSectionId, date
//
// UPDATED RESPONSE SHAPE (breaking change from old shape):
//
//   {
//     session: {
//       date: "2026-05-10",
//       classSectionId: 12,
//       isFullyMarked: false,       ← true only when every student has a record
//       isPartiallyMarked: true,    ← true when ≥1 but not all students are marked
//       markedCount: 18,
//       totalCount: 42,
//       lastMarkedBy: {
//         userId: 7,
//         name: "Priya Sharma"
//       },
//       lastUpdatedAt: "2026-05-10T08:32:14.000Z"
//     },
//     students: [
//       {
//         enrollmentId: 101,
//         studentId: 55,
//         studentName: "Aarav Singh",
//         rollNumber: "3",
//         avatarUrl: null,
//         attendanceRecord: {          ← null when not yet marked for this date
//           id: 2001,
//           status: "PRESENT",
//           halfDaySession: null,
//           notes: null,
//           markedBy: 7,
//           markedByName: "Priya Sharma",
//           updatedAt: "2026-05-10T08:32:14.000Z"
//         }
//       },
//       {
//         enrollmentId: 102,
//         studentId: 56,
//         studentName: "Diya Patel",
//         rollNumber: "4",
//         avatarUrl: null,
//         attendanceRecord: null       ← not yet marked — default to PRESENT on frontend
//       },
//       ...
//     ]
//   }
//
// Frontend contract:
//   1. Check session.isFullyMarked / isPartiallyMarked to show the status banner.
//   2. Students with attendanceRecord === null have not been marked yet.
//      Default their status to PRESENT in the form before the teacher submits.
//   3. Students with attendanceRecord !== null show their existing status.
//      Teacher can still edit (form is pre-populated).
// ─────────────────────────────────────────────────────────────────────────────
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

export default attendanceRouter;
