// src/modules/school/subjects/routes.ts

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
  assignSubjectToClass,
  assignTeacherToSubject,
  bulkCreateSubjects,
  bulkUpdateSubjects,
  createSubject,
  deleteSubject,
  getAllClassSubjects,
  getClassSectionSubjectById,
  getClassSectionSubjects,
  getClassSectionSubjectTeachers,
  getSubjects,
  getTeacherAssignments,
  getTeachers,
  unassignSubjectFromClassSection,
  unassignTeacherFromSubject,
  updateSubject,
} from "./services";

const subjectsRouter = new Hono<SchoolEnv>();

subjectsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Subject CRUD ====================
const subjectSchema = z.object({
  name: z.string().min(3).max(50),

  code: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().min(3).max(10).optional()
  ),

  description: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.string().min(1).optional()
  ),
});

subjectsRouter.post(
  "/",
  requirePermission("academics.subjects.manage"),
  zValidator("json", subjectSchema),
  async (c) => {
    try {
      const data = c.req.valid("json"); // ✅ use this — already parsed by zValidator
      const schoolCode = c.get("schoolCode")!;
      const result = await createSubject(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Subject creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.get(
  "/",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;

      const subjects = await getSubjects(c.env, schoolCode);

      return c.json({ subjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== BULK CREATE SUBJECTS ====================
/**
 * POST /school/subjects/bulk
 *
 * Bulk-create up to 100 subjects in a single request.
 *
 * Request body:
 *   { subjects: Array<{ name: string; code?: string; description?: string }> }
 *
 * Response (201):
 *   {
 *     subjects: SchoolSubject[];   // newly created rows
 *     skipped: string[];           // names that already existed
 *     errors: string[];            // code-collision messages etc.
 *     message: string;
 *   }
 */
const bulkSubjectSchema = z.object({
  subjects: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        code: z.preprocess(
          (v) => (v === "" || v === null || v === undefined ? undefined : v),
          z.string().min(2).max(10).optional()
        ),
        description: z.preprocess(
          (v) => (v === "" || v === null || v === undefined ? undefined : v),
          z.string().min(1).max(500).optional()
        ),
      })
    )
    .min(1)
    .max(100, "Cannot submit more than 100 subjects at once"),
});

subjectsRouter.post(
  "/bulk",
  requirePermission("academics.subjects.manage"),
  zValidator("json", bulkSubjectSchema),
  async (c) => {
    try {
      const { subjects } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkCreateSubjects(c.env, schoolCode, subjects);
      // Return 201 if anything was created; 200 if everything was skipped
      const status = result.subjects.length > 0 ? 201 : 200;
      return c.json(result, status);
    } catch (error: any) {
      console.error("Bulk subject creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== BULK UPDATE SUBJECTS ====================
/**
 * PUT /school/subjects/bulk
 *
 * Bulk-update up to 100 subjects in a single request.
 * Each item must include its `id`. Only provided fields are updated.
 *
 * Request body:
 *   { subjects: Array<{ id: number; name?: string; code?: string | null; description?: string | null }> }
 *
 * Response (200):
 *   {
 *     subjects: SchoolSubject[];   // updated rows
 *     notFound: number[];          // ids that don't exist
 *     errors: string[];            // collision / validation messages
 *     message: string;
 *   }
 */
const bulkUpdateSubjectSchema = z.object({
  subjects: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        code: z.union([z.string().min(2).max(10), z.null()]).optional(),
        description: z.union([z.string().min(1).max(500), z.null()]).optional(),
      })
    )
    .min(1)
    .max(100, "Cannot update more than 100 subjects at once"),
});

subjectsRouter.put(
  "/bulk",
  requirePermission("academics.subjects.manage"),
  zValidator("json", bulkUpdateSubjectSchema),
  async (c) => {
    try {
      const { subjects } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await bulkUpdateSubjects(c.env, schoolCode, subjects);
      return c.json(result, 200);
    } catch (error: any) {
      console.error("Bulk subject update error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.put(
  "/:id",
  requirePermission("academics.subjects.manage"),
  zValidator("json", subjectSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateSubject(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.delete(
  "/:id",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await deleteSubject(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== ASSIGN SUBJECT TO CLASS-SECTION ====================
const assignToClassSchema = z.object({
  classSectionId: z.number(),
  subjectId: z.number(),
  isMandatory: z.boolean().default(true),
});

subjectsRouter.post(
  "/assign-class-section",
  requirePermission("academics.subjects.manage"),
  zValidator("json", assignToClassSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await assignSubjectToClass(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.delete(
  "/unassign-class/:classSectionSubjectId",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("classSectionSubjectId"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await unassignSubjectFromClassSection(
        c.env,
        schoolCode,
        id
      );
      return c.json(result);
    } catch (error: any) {
      console.error("Unassign error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== CLASS-SECTION SUBJECT QUERIES ====================

// ==================== Get Subjects for a Class-Section ====================
subjectsRouter.get(
  "/class-subjects/:classSectionId",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const classSectionId = parseInt(c.req.param("classSectionId"));
      if (isNaN(classSectionId)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const subjects = await getClassSectionSubjects(
        c.env,
        schoolCode,
        classSectionId
      );
      return c.json({ subjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

subjectsRouter.get(
  "/class-subject/:classSectionSubjectId",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("classSectionSubjectId"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const classSectionSubject = await getClassSectionSubjectById(
        c.env,
        schoolCode,
        id
      );
      return c.json({ classSectionSubject });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

subjectsRouter.get(
  "/all-class-subjects",
  requirePermission("academics.subjects.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const classSubjects = await getAllClassSubjects(c.env, schoolCode);
      return c.json({ classSubjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== TEACHER ASSIGNMENTS ====================
const assignTeacherSchema = z.object({
  teacherId: z.number().int().positive(),
  classSectionSubjectId: z.number().int().positive(),
  isPrimary: z.boolean().default(false),
});

subjectsRouter.post(
  "/assign-teacher",
  requirePermission("academics.assign-teacher"),
  zValidator("json", assignTeacherSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await assignTeacherToSubject(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.delete(
  "/unassign-teacher/:assignmentId",
  requirePermission("academics.assign-teacher"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("assignmentId"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const result = await unassignTeacherFromSubject(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      console.error("Unassign teacher error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.get(
  "/teacher-assignments/:teacherId",
  requirePermission("academics.assign-teacher"),
  async (c) => {
    try {
      const teacherId = parseInt(c.req.param("teacherId"));
      if (isNaN(teacherId)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const assignments = await getTeacherAssignments(
        c.env,
        schoolCode,
        teacherId
      );
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

subjectsRouter.get(
  "/class-subject-teachers/:classSectionSubjectId",
  requirePermission("academics.assign-teacher"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("classSectionSubjectId"));
      if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const assignments = await getClassSectionSubjectTeachers(
        c.env,
        schoolCode,
        id
      );
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get All Teachers ====================
subjectsRouter.get(
  "/teachers",
  requirePermission("academics.assign-teacher"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const teachers = await getTeachers(c.env, schoolCode);
      return c.json({ teachers });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

export default subjectsRouter;
