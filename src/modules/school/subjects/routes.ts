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
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().min(3).max(10).optional()
  ),

  description: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
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
