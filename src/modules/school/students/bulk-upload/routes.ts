// src/modules/school/students/bulk-upload/routes.ts

import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolEnv } from "../../../../types/common-types";
import { bulkUploadStudents, getClassSectionCapacityInfo } from "./services";

const bulkUploadRouter = new Hono<SchoolEnv>();

bulkUploadRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== GET CAPACITY INFO ====================
// GET /school/students/bulk-upload/capacity/:classSectionId
bulkUploadRouter.get(
  "/capacity/:classSectionId",
  requirePermission(["students.bulk-upload", "academics.enroll"]),
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
      const info = await getClassSectionCapacityInfo(
        c.env,
        schoolCode,
        classSectionId
      );

      return c.json({ success: true, ...info });
    } catch (error: any) {
      console.error("[bulk-upload] capacity info error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== BULK UPLOAD STUDENTS ====================
// POST /school/students/bulk-upload
// Content-Type: multipart/form-data
//
// Form fields:
//   classSectionId  (number, required)
//   academicYearId  (number, optional — defaults to current year)
//   file            (File, required — .xlsx or .xls, max 10 MB)
//
// Response codes:
//   200 — all rows successful
//   207 — partial success (some rows failed)
//   400 — parse / validation error (bad form data or file format)
//   409 — email conflicts found (NO students inserted); body contains emailConflicts[]
//   500 — unexpected server error
bulkUploadRouter.post(
  "/",
  requirePermission(["students.bulk-upload", "academics.enroll"]),
  async (c) => {
    try {
      const uploader = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      // ── Parse multipart form data ─────────────────────────────────────────
      const formData = await c.req.formData();

      const classSectionIdRaw = formData.get("classSectionId");
      const academicYearIdRaw = formData.get("academicYearId");
      const file = formData.get("file") as File | null;

      // Validate required fields
      if (!classSectionIdRaw) {
        return c.json(
          { success: false, error: "classSectionId is required" },
          400
        );
      }
      if (!file) {
        return c.json({ success: false, error: "file is required" }, 400);
      }

      // Validate classSectionId
      const classSectionId = parseInt(String(classSectionIdRaw), 10);
      if (isNaN(classSectionId) || classSectionId <= 0) {
        return c.json(
          {
            success: false,
            error: "classSectionId must be a positive integer",
          },
          400
        );
      }

      // Validate optional academicYearId
      let academicYearId: number | undefined;
      if (academicYearIdRaw) {
        const parsed = parseInt(String(academicYearIdRaw), 10);
        if (!isNaN(parsed) && parsed > 0) {
          academicYearId = parsed;
        }
        // If provided but invalid, silently fall back to current year
        // (do not reject — some clients always send the field even when empty)
      }

      // ── Validate file type ────────────────────────────────────────────────
      const fileName = file.name.toLowerCase();
      if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
        return c.json(
          {
            success: false,
            error:
              "Only Excel files are accepted (.xlsx or .xls). " +
              "Please download the student upload template and fill it in Excel.",
          },
          400
        );
      }

      // ── Validate file size (max 10 MB) ────────────────────────────────────
      const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
      if (file.size > MAX_SIZE_BYTES) {
        return c.json(
          {
            success: false,
            error: `File size (${(file.size / 1024 / 1024).toFixed(
              1
            )} MB) exceeds the 10 MB limit. Please split into smaller batches.`,
          },
          400
        );
      }

      // ── Read file buffer ──────────────────────────────────────────────────
      const arrayBuffer = await file.arrayBuffer();
      const fileBuffer = new Uint8Array(arrayBuffer);

      // ── Run bulk upload ───────────────────────────────────────────────────
      const result = await bulkUploadStudents(c.env, schoolCode, {
        classSectionId,
        academicYearId,
        fileBuffer,
        uploadedBy: uploader.id,
      });

      // ── Select response status ────────────────────────────────────────────

       // Email OR username conflicts: 409 so Angular catchError receives them distinctly.
       if (
        (result.emailConflicts && result.emailConflicts.length > 0) ||
        (result.usernameConflicts && result.usernameConflicts.length > 0) || (result.admissionNumberConflicts && result.admissionNumberConflicts.length > 0)
        
      ) {
        return c.json(result, 409);
      }

      // Explicit failure (parse error, capacity exceeded, no valid rows, etc.)
      if (!result.success && result.summary.successful === 0) {
        return c.json(result, 400);
      }

      // Partial success
      if (result.summary.failed > 0) {
        return c.json(result, 207);
      }

      // Full success
      return c.json(result, 200);
    } catch (error: any) {
      console.error("[bulk-upload] unexpected error:", {
        message: error.message,
        stack: error.stack,
      });
      return c.json(
        {
          success: false,
          error:
            error.message || "Bulk upload failed due to an unexpected error",
          results: [],
        },
        500
      );
    }
  }
);

export default bulkUploadRouter;
