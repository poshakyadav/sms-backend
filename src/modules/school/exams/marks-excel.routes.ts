// src/modules/school/exams/marks-excel.routes.ts
//
// ─── EXCEL MARKS BULK ENTRY — ROUTE HANDLERS ─────────────────────────────────
//
// Add these two routes inside examsRouter in …/school/exams/routes.ts:
//
//   import { marksExcelRoutes } from "./marks-excel.routes";
//   marksExcelRoutes(examsRouter);
//
// Or simply copy the two route blocks directly into routes.ts.
//
// Routes added:
//   GET  /school/exams/marks/excel/template   → download template
//   POST /school/exams/marks/excel/upload     → upload + upsert
// ─────────────────────────────────────────────────────────────────────────────

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
  bulkUpsertMarks,
  generateMarksTemplate,
  parseMarksTemplate,
} from "./marks-excel.service";

// ─────────────────────────────────────────────────────────────────────────────
// Exported factory — call this from routes.ts
// ─────────────────────────────────────────────────────────────────────────────
export function registerMarksExcelRoutes(router: Hono<SchoolEnv>) {
  // Auth is already applied on the parent examsRouter, but we apply again here
  // so this file can also be used as a standalone mounted router if needed.
  router.use(
    "/marks/excel/*",
    schoolJwtMiddleware,
    schoolTokenValidationMiddleware
  );

  // ── GET /school/exams/marks/excel/template ──────────────────────────────────
  // Downloads a pre-filled .xlsx template for a given exam + subject.
  // If marks were previously entered they are pre-filled so the teacher can
  // download → correct → re-upload without re-entering everything.
  //
  // Query params:
  //   examId         (number, required)
  //   classSubjectId (number, required)
  router.get(
    "/marks/excel/template",
    requirePermission("exams.marks.enter"),
    zValidator(
      "query",
      z.object({
        examId: z.coerce
          .number()
          .int()
          .positive({ message: "examId must be a positive integer" }),
        classSubjectId: z.coerce
          .number()
          .int()
          .positive({ message: "classSubjectId must be a positive integer" }),
      })
    ),
    async (c) => {
      try {
        const { examId, classSubjectId } = c.req.valid("query");
        const schoolCode = c.get("schoolCode")!;
        const user = c.get("user")!;

        const { buffer, filename } = await generateMarksTemplate(
          c.env,
          schoolCode,
          examId,
          classSubjectId,
          user.id
        );

        // Stream the file back as an attachment
        return new Response(buffer, {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(
              filename
            )}"`,
            "Content-Length": String(buffer.byteLength),
            // Prevent proxies from caching file downloads
            "Cache-Control": "no-store",
          },
        });
      } catch (error: any) {
        console.error("[marks-excel] template generation error:", error);
        return c.json(
          {
            success: false,
            error: error.message || "Failed to generate template",
          },
          error.message?.includes("not found") ? 404 : 500
        );
      }
    }
  );

  // ── POST /school/exams/marks/excel/upload ───────────────────────────────────
  // Accepts a multipart/form-data upload with a single "file" field.
  // Parses + validates the .xlsx, then bulk-upserts marks.
  //
  // Idempotent: re-uploading the same or corrected file is always safe.
  //
  // Form fields:
  //   file  (File / Blob, required)  — the .xlsx produced by the template endpoint
  router.post(
    "/marks/excel/upload",
    requirePermission("exams.marks.enter"),
    async (c) => {
      try {
        const user = c.get("user")!;
        const schoolCode = c.get("schoolCode")!;

        // ── Parse multipart ────────────────────────────────────────────────
        let formData: FormData;
        try {
          formData = await c.req.formData();
        } catch {
          return c.json(
            {
              success: false,
              error: "Request must be multipart/form-data with a 'file' field.",
            },
            400
          );
        }

        const fileField = formData.get("file");
        if (!fileField || typeof fileField === "string") {
          return c.json(
            {
              success: false,
              error: "No file uploaded. Include a 'file' field.",
            },
            400
          );
        }

        // ── Size guard (10 MB is way more than any realistic marks sheet) ──
        const MAX_BYTES = 10 * 1024 * 1024;
        const fileBlob = fileField as Blob;
        if (fileBlob.size > MAX_BYTES) {
          return c.json(
            {
              success: false,
              error: "File too large. Maximum allowed size is 10 MB.",
            },
            413
          );
        }

        // ── MIME type check (basic — real validation happens inside parser) ─
        const fileName = (fileBlob as any).name ?? "";
        const allowedExts = [".xlsx"];
        const hasValidExt = allowedExts.some((ext) =>
          fileName.toLowerCase().endsWith(ext)
        );
        if (!hasValidExt && fileName) {
          return c.json(
            {
              success: false,
              error: `Invalid file type. Only .xlsx files are accepted. Got: "${fileName}"`,
            },
            415
          );
        }

        // ── Read into buffer ───────────────────────────────────────────────
        const arrayBuffer = await fileBlob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // ── Parse + validate template ──────────────────────────────────────
        const parseResult = await parseMarksTemplate(c.env, schoolCode, buffer);

        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                "Validation failed. Please fix the issues below and re-upload.",
              errors: parseResult.errors,
            },
            422
          );
        }

        // ── Bulk upsert ────────────────────────────────────────────────────
        const upsertResult = await bulkUpsertMarks(
          c.env,
          schoolCode,
          parseResult.examId,
          parseResult.classSubjectId,
          parseResult.rows,
          user.id,
          parseResult.warnings
        );

        return c.json({
          success: true,
          message: buildSuccessMessage(upsertResult),
          details: {
            inserted: upsertResult.inserted,
            updated: upsertResult.updated,
            total: upsertResult.inserted + upsertResult.updated,
          },
          warnings: upsertResult.warnings,
        });
      } catch (error: any) {
        console.error("[marks-excel] upload error:", error);
        return c.json(
          {
            success: false,
            error: error.message || "Failed to process uploaded file",
          },
          500
        );
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────
function buildSuccessMessage(r: { inserted: number; updated: number }): string {
  const parts: string[] = [];
  if (r.inserted > 0) parts.push(`${r.inserted} new mark(s) saved`);
  if (r.updated > 0) parts.push(`${r.updated} mark(s) updated`);
  if (parts.length === 0) return "No changes made.";
  return parts.join(", ") + " successfully.";
}
