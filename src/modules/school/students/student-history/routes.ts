// src/modules/school/students/history/routes.ts
//
// STUDENT HISTORY MODULE — ROUTES
// ─────────────────────────────────────────────────────────────────────────────
//
// ENDPOINTS
//
//   GET /school/students/history
//       Paginated list of ALL students (active + departed/alumni).
//       Supports rich search: name, email, phone, admissionNumber,
//       fatherName, motherName, rollNumber.
//       Supports status filter: active | departed | all (default: all)
//
//   GET /school/students/history/search
//       Dedicated fast-search endpoint — returns lightweight matches
//       suitable for autocomplete / search-as-you-type dropdowns.
//       Same search fields as above.
//
//   GET /school/students/:id/history/summary
//       Lightweight stats card for one student.
//       Works for active students AND departed/alumni.
//
//   GET /school/students/:id/history
//       Full paginated timeline for one student.
//       Works for active students AND departed/alumni.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolEnv } from "../../../../types/common-types";
import {
  getStudentHistory,
  getStudentHistorySummary,
  getAllStudentsHistory,
  searchStudents,
} from "./services";

const studentHistoryRouter = new Hono<SchoolEnv>();

// ── Auth ──────────────────────────────────────────────────────────────────────
studentHistoryRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ─────────────────────────────────────────────────────────────────────────────
// QUERY SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full history timeline query params.
 *
 * eventType   — comma-separated domain filter:
 *               ENROLLMENT | ATTENDANCE | FEE | EXAM | ASSIGNMENT | PROFILE
 * dateFrom    — ISO date "YYYY-MM-DD" (inclusive)
 * dateTo      — ISO date "YYYY-MM-DD" (inclusive)
 * page/limit  — pagination (default 1 / 50, hard cap 200)
 */
const historyQuerySchema = z.object({
  academicYearId: z.string().regex(/^\d+$/).transform(Number).optional(),
  eventType: z.string().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  page: z.string().regex(/^\d+$/).transform(Number).optional().default(1),
  limit: z.string().regex(/^\d+$/).transform(Number).optional().default(50),
});

/**
 * Bulk listing / search query params.
 *
 * q            — universal search term. Matched against:
 *                name, email, phone, admissionNumber,
 *                fatherName, motherName, guardianName, rollNumber
 * status       — "active"    → only currently enrolled students
 *                "departed"  → only students with no active enrollment
 *                              (left school, unenrolled permanently, etc.)
 *                "all"       → everyone (default)
 * academicYearId — scope enrollment context to a specific year
 * sortBy       — name | admissionDate | createdAt (default: name)
 * sortOrder    — asc | desc (default: asc)
 */
const bulkHistoryQuerySchema = z.object({
  q: z.string().max(150).optional(),
  // Individual field search (used when frontend has separate inputs)
  name: z.string().max(100).optional(),
  email: z.string().max(150).optional(),
  phone: z.string().max(20).optional(),
  admissionNumber: z.string().max(50).optional(),
  fatherName: z.string().max(150).optional(),
  motherName: z.string().max(150).optional(),
  rollNumber: z.string().max(50).optional(),
  // Filters
  status: z.enum(["active", "departed", "all"]).optional().default("all"),
  academicYearId: z.string().regex(/^\d+$/).transform(Number).optional(),
  // Sorting
  sortBy: z
    .enum(["name", "admissionDate", "createdAt"])
    .optional()
    .default("name"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("asc"),
  // Pagination
  page: z.string().regex(/^\d+$/).transform(Number).optional().default(1),
  limit: z.string().regex(/^\d+$/).transform(Number).optional().default(30),
});

/**
 * Fast-search query — lightweight, for autocomplete.
 *
 * q      — search term (required, min 2 chars)
 * limit  — max results (default 10, hard cap 20)
 * status — same as above
 */
const searchQuerySchema = z.object({
  q: z.string().min(2).max(150),
  status: z.enum(["active", "departed", "all"]).optional().default("all"),
  limit: z.string().regex(/^\d+$/).transform(Number).optional().default(10),
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/history/search   (fast autocomplete — before /:id routes)
// ─────────────────────────────────────────────────────────────────────────────
studentHistoryRouter.get(
  "/search",
  requirePermission("students.list"),
  zValidator("query", searchQuerySchema),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const { q, status, limit } = c.req.valid("query");

      const results = await searchStudents(c.env, schoolCode, {
        q,
        status,
        limit: Math.min(limit, 20),
      });

      return c.json({ success: true, results });
    } catch (error: any) {
      console.error("Student search error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/history   (bulk listing with search + filters)
// ─────────────────────────────────────────────────────────────────────────────
studentHistoryRouter.get(
  "/",
  requirePermission("students.list"),
  zValidator("query", bulkHistoryQuerySchema),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const query = c.req.valid("query");

      const result = await getAllStudentsHistory(c.env, schoolCode, {
        q: query.q,
        name: query.name,
        email: query.email,
        phone: query.phone,
        admissionNumber: query.admissionNumber,
        fatherName: query.fatherName,
        motherName: query.motherName,
        rollNumber: query.rollNumber,
        status: query.status,
        academicYearId: query.academicYearId,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        page: query.page,
        limit: Math.min(query.limit, 100),
      });

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Get all students history error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/:id/history/summary
// ─────────────────────────────────────────────────────────────────────────────
studentHistoryRouter.get(
  "/:id/summary",
  requirePermission("students.list"),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("id"));
      if (isNaN(studentId))
        return c.json({ success: false, error: "Invalid student ID" }, 400);

      const schoolCode = c.get("schoolCode")!;
      const summary = await getStudentHistorySummary(
        c.env,
        schoolCode,
        studentId
      );

      if (!summary)
        return c.json({ success: false, error: "Student not found" }, 404);

      return c.json({ success: true, summary });
    } catch (error: any) {
      console.error("Get student history summary error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/:id/history   (full paginated timeline)
// ─────────────────────────────────────────────────────────────────────────────
studentHistoryRouter.get(
  "/:id",
  requirePermission("students.list"),
  zValidator("query", historyQuerySchema),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("id"));
      if (isNaN(studentId))
        return c.json({ success: false, error: "Invalid student ID" }, 400);

      const schoolCode = c.get("schoolCode")!;
      const query = c.req.valid("query");

      const eventTypeFilter = query.eventType
        ? new Set(
            query.eventType
              .toUpperCase()
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          )
        : null;

      const result = await getStudentHistory(c.env, schoolCode, studentId, {
        academicYearId: query.academicYearId,
        eventTypeFilter,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        page: query.page,
        limit: Math.min(query.limit, 200),
      });

      if (!result)
        return c.json({ success: false, error: "Student not found" }, 404);

      return c.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Get student history error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

export default studentHistoryRouter;
