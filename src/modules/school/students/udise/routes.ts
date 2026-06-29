// src/modules/school/students/udise/routes.ts
// PRODUCTION-GRADE — UDISE+ 2025-26 Student Data Module
//
// Endpoints:
//   GET  /school/students/udise/profile/:studentId        — full UDISE profile for one student
//   PUT  /school/students/udise/profile/:studentId        — update UDISE fields for one student
//   GET  /school/students/udise/completeness              — school-wide UDISE completeness report
//   GET  /school/students/udise/export                    — download UDISE+ SDMS-compatible .xlsx
//   GET  /school/students/udise/export/class-section/:id  — export for one class-section
//
// All endpoints require JWT + token validation.
// Export endpoints require  students.bulk-upload  OR  students.profile.manage  permission.
// Profile read/write requires  students.profile.manage  permission.

import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolEnv } from "../../../../types/common-types";
import {
  exportUDISEExcel,
  getSchoolUDISECompleteness,
  getStudentUDISEProfile,
  updateStudentUDISEProfile,
} from "./services";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

const udiseRouter = new Hono<SchoolEnv>();

udiseRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/udise/profile/:studentId
// Returns all UDISE-relevant fields for a single student.
// ─────────────────────────────────────────────────────────────────────────────
udiseRouter.get(
  "/profile/:studentId",
  requirePermission("students.profile.manage"),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"), 10);
      if (isNaN(studentId) || studentId <= 0) {
        return c.json({ success: false, error: "Invalid student ID" }, 400);
      }

      const schoolCode = c.get("schoolCode")!;
      const profile = await getStudentUDISEProfile(
        c.env,
        schoolCode,
        studentId
      );

      if (!profile) {
        return c.json({ success: false, error: "Student not found" }, 404);
      }

      return c.json({ success: true, profile });
    } catch (error: any) {
      console.error("[udise] get profile error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /school/students/udise/profile/:studentId
// Update UDISE-specific fields for a single student.
// Only the fields explicitly listed here are writable via this endpoint —
// name, email, password changes go through the main users module.
// ─────────────────────────────────────────────────────────────────────────────
const updateUDISEProfileSchema = z.object({
  // ── Parental / guardian (schoolUsersSchema) ─────────────────────────────────
  fatherName: z.string().max(150).optional(),
  motherName: z.string().max(150).optional(),
  guardianName: z.string().max(150).optional(),
  guardianRelation: z.string().max(100).optional(),

  // ── UDISE / National identity (studentsSchema) ──────────────────────────────
  pen: z
    .string()
    .regex(/^\d{16}$/, "PEN must be exactly 16 digits")
    .nullable()
    .optional(),
  apaarId: z
    .string()
    .regex(/^\d{12}$/, "APAAR ID must be exactly 12 digits")
    .nullable()
    .optional(),
  stateStudentId: z.string().max(50).nullable().optional(),
  aadhaarMasked: z
    .string()
    .regex(
      /^XXXX XXXX \d{4}$/,
      'Aadhaar must be masked format "XXXX XXXX 1234"'
    )
    .nullable()
    .optional(),
  aadhaarName: z.string().max(150).nullable().optional(),
  previousSchoolUdiseCode: z
    .string()
    .regex(/^\d{11}$/, "Previous school UDISE code must be exactly 11 digits")
    .nullable()
    .optional(),

  // ── Academic / UDISE+ DCF fields ────────────────────────────────────────────
  enrollmentType: z.enum(["REGULAR", "PRIVATE", "OPEN_SCHOOL"]).optional(),
  previousClassResult: z
    .enum(["PROMOTED", "NOT_PROMOTED", "NEW_ADMISSION", "TRANSFERRED"])
    .nullable()
    .optional(),
  admissionNumber: z.string().max(50).nullable().optional(),
  admissionDate: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined))
    .pipe(z.string().date().optional()),
  previousSchool: z.string().max(255).optional(),
  rollNumber: z.string().max(50).optional(),

  // ── UDISE+ Demographic ──────────────────────────────────────────────────────
  socialCategory: z.number().int().min(1).max(5).nullable().optional(),
  religion: z.number().int().min(1).max(8).nullable().optional(),
  isMinority: z.boolean().optional(),
  motherTongueCode: z.number().int().positive().nullable().optional(),

  // ── Socio-economic ──────────────────────────────────────────────────────────
  isBpl: z.boolean().optional(),
  localityType: z.enum(["URBAN", "RURAL"]).nullable().optional(),

  // ── CWSN ────────────────────────────────────────────────────────────────────
  isCwsn: z.boolean().optional(),
  disabilityType: z.number().int().min(1).max(9).nullable().optional(),
  hasDisabilityCertificate: z.boolean().optional(),
  udidNumber: z.string().max(30).nullable().optional(),

  // ── Facilities received (JSON array of string codes) ────────────────────────
  facilitiesReceived: z
    .array(
      z.enum([
        "FREE_TEXTBOOKS",
        "FREE_UNIFORM",
        "FREE_TRANSPORT",
        "FREE_BICYCLE",
        "SCHOLARSHIP",
        "MID_DAY_MEAL",
        "FREE_STATIONERY",
        "OTHERS",
      ])
    )
    .optional(),

  // ── Verification flags ───────────────────────────────────────────────────────
  isAadhaarVerified: z.boolean().optional(),
  udiseVerified: z.boolean().optional(),
});

udiseRouter.put(
  "/profile/:studentId",
  requirePermission("students.profile.manage"),
  zValidator("json", updateUDISEProfileSchema, (result, c) => {
    if (!result.success) {
      console.error(
        "[udise] PUT validation failed:",
        JSON.stringify(result.error.issues, null, 2)
      );
      return c.json(
        {
          success: false,
          error: "Validation failed",
          issues: result.error.issues,
        },
        400
      );
    }
  }),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"), 10);
      if (isNaN(studentId) || studentId <= 0) {
        return c.json({ success: false, error: "Invalid student ID" }, 400);
      }

      const data = c.req.valid("json");
      const updater = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      // console.log("[udise] PUT validated data:", JSON.stringify(data, null, 2));

      await updateStudentUDISEProfile(
        c.env,
        schoolCode,
        studentId,
        data,
        updater.id
      );

      return c.json({
        success: true,
        message: "UDISE profile updated successfully",
      });
    } catch (error: any) {
      console.error("[udise] update profile error:", error);
      const isNotFound = error.message?.includes("not found");
      return c.json(
        {
          success: false,
          error: error.message || "Failed to update UDISE profile",
        },
        isNotFound ? 404 : 400
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/udise/completeness?academicYearId=&classSectionId=
// School-wide UDISE data completeness dashboard.
// Shows per-student completeness score and missing fields for each GP/EP/SF section.
// ─────────────────────────────────────────────────────────────────────────────
udiseRouter.get(
  "/completeness",
  requirePermission("students.profile.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const academicYearId = c.req.query("academicYearId")
        ? parseInt(c.req.query("academicYearId")!, 10)
        : undefined;
      const classSectionId = c.req.query("classSectionId")
        ? parseInt(c.req.query("classSectionId")!, 10)
        : undefined;

      if (academicYearId !== undefined && isNaN(academicYearId)) {
        return c.json({ success: false, error: "Invalid academicYearId" }, 400);
      }
      if (classSectionId !== undefined && isNaN(classSectionId)) {
        return c.json({ success: false, error: "Invalid classSectionId" }, 400);
      }

      const report = await getSchoolUDISECompleteness(c.env, schoolCode, {
        academicYearId,
        classSectionId,
      });

      return c.json({ success: true, ...report });
    } catch (error: any) {
      console.error("[udise] completeness error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/udise/export?academicYearId=&classSectionId=&format=xlsx
// Download UDISE+ 2025-26 SDMS-compatible Excel file for the whole school
// or filtered by class-section / academic year.
// ─────────────────────────────────────────────────────────────────────────────
udiseRouter.get(
  "/export",
  requirePermission(["students.bulk-upload", "students.profile.manage"]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const academicYearId = c.req.query("academicYearId")
        ? parseInt(c.req.query("academicYearId")!, 10)
        : undefined;
      const classSectionId = c.req.query("classSectionId")
        ? parseInt(c.req.query("classSectionId")!, 10)
        : undefined;

      if (academicYearId !== undefined && isNaN(academicYearId)) {
        return c.json({ success: false, error: "Invalid academicYearId" }, 400);
      }
      if (classSectionId !== undefined && isNaN(classSectionId)) {
        return c.json({ success: false, error: "Invalid classSectionId" }, 400);
      }

      const { buffer, filename, studentCount } = await exportUDISEExcel(
        c.env,
        schoolCode,
        { academicYearId, classSectionId }
      );

      if (studentCount === 0) {
        return c.json(
          {
            success: false,
            error: "No enrolled students found for the selected filters.",
          },
          404
        );
      }

      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Student-Count": String(studentCount),
        },
      });
    } catch (error: any) {
      console.error("[udise] export error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /school/students/udise/export/class-section/:classSectionId
// Convenience shorthand — export for a specific class-section only.
// ─────────────────────────────────────────────────────────────────────────────
udiseRouter.get(
  "/export/class-section/:classSectionId",
  requirePermission(["students.bulk-upload", "students.profile.manage"]),
  async (c) => {
    try {
      const classSectionId = parseInt(c.req.param("classSectionId"), 10);
      if (isNaN(classSectionId) || classSectionId <= 0) {
        return c.json(
          { success: false, error: "Invalid class section ID" },
          400
        );
      }

      const schoolCode = c.get("schoolCode")!;
      const academicYearId = c.req.query("academicYearId")
        ? parseInt(c.req.query("academicYearId")!, 10)
        : undefined;

      const { buffer, filename, studentCount } = await exportUDISEExcel(
        c.env,
        schoolCode,
        { academicYearId, classSectionId }
      );

      if (studentCount === 0) {
        return c.json(
          {
            success: false,
            error: "No enrolled students found for this class-section.",
          },
          404
        );
      }

      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Student-Count": String(studentCount),
        },
      });
    } catch (error: any) {
      console.error("[udise] export class-section error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

export default udiseRouter;
