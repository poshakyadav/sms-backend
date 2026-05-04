// src/modules/school/students/bulk-upload/routes.ts
// Key change: email conflicts return HTTP 409 with emailConflicts[] array
// so the frontend can render the "fix these emails" popup without any inserts happening.

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
      const classSectionId = parseInt(c.req.param("classSectionId"));
      if (isNaN(classSectionId)) {
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
      console.error("Capacity info error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== BULK UPLOAD STUDENTS ====================
// POST /school/students/bulk-upload
// Content-Type: multipart/form-data
// Fields: classSectionId (number), academicYearId? (number), file (xlsx)
//
// Response codes:
//   200 — all rows successful
//   207 — partial success (some rows failed)
//   400 — parse / validation error
//   409 — email conflicts found (no students inserted); body has emailConflicts[]
//   500 — unexpected server error
bulkUploadRouter.post(
  "/",
  requirePermission(["students.bulk-upload", "academics.enroll"]),
  async (c) => {
    try {
      const uploader = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      const formData = await c.req.formData();
      const classSectionIdRaw = formData.get("classSectionId");
      const academicYearIdRaw = formData.get("academicYearId");
      const file = formData.get("file") as File | null;

      if (!classSectionIdRaw || !file) {
        return c.json(
          { success: false, error: "classSectionId and file are required" },
          400
        );
      }

      const classSectionId = parseInt(String(classSectionIdRaw));
      const academicYearId = academicYearIdRaw
        ? parseInt(String(academicYearIdRaw))
        : undefined;

      if (isNaN(classSectionId)) {
        return c.json({ success: false, error: "Invalid classSectionId" }, 400);
      }

      const fileName = file.name.toLowerCase();
      if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
        return c.json(
          { success: false, error: "Only .xlsx and .xls files are allowed" },
          400
        );
      }
      if (file.size > 5 * 1024 * 1024) {
        return c.json(
          { success: false, error: "File size must be less than 5MB" },
          400
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      const fileBuffer = new Uint8Array(arrayBuffer);

      const result = await bulkUploadStudents(c.env, schoolCode, {
        classSectionId,
        academicYearId,
        fileBuffer,
        uploadedBy: uploader.id,
      });

      // Email conflicts: return 409 so Angular's catchError receives them
      if (result.emailConflicts && result.emailConflicts.length > 0) {
        return c.json(result, 409 as any);
      }

      // Partial / full success
      const status = result.success
        ? result.summary.failed > 0
          ? 207
          : 200
        : 400;

      return c.json(result, status as any);
    } catch (error: any) {
      console.error("Bulk upload error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Bulk upload failed",
          results: [],
        },
        500
      );
    }
  }
);

export default bulkUploadRouter;
