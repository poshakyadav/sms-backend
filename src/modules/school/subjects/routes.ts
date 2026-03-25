import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { schoolJwtMiddleware, schoolTokenValidationMiddleware, schoolPermissionMiddleware } from '../../../middleware/school-auth';
import { SchoolEnv } from '../../../types/common-types';
import { SchoolRole } from '../../../types/school-role';
import { createSubject, getSubjects, updateSubject, deleteSubject, assignSubjectToClass, assignTeacherToSubject, getTeacherAssignments, getClassSubjectById, unassignSubjectFromClass, getAllClassSubjects, unassignTeacherFromSubject, getClassSubjectTeachers, getTeachers, getClassSectionSubjects } from './services';

const subjectsRouter = new Hono<SchoolEnv>();

subjectsRouter.use('*', schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Subject CRUD ====================
const subjectSchema = z.object({
  name: z.string().min(3).max(50),
  code: z.string().min(3).max(10).optional(),
  description: z.string().optional(),
});

subjectsRouter.post(
  '/',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator('json', subjectSchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const schoolCode = c.get('schoolCode')!;

      const result = await createSubject(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      console.error('Subject creation error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.get(
  '/',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const schoolCode = c.get('schoolCode')!;

      const subjects = await getSubjects(c.env, schoolCode);

      return c.json({ subjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

subjectsRouter.put(
  '/:id',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator('json', subjectSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      const data = c.req.valid('json');
      const schoolCode = c.get('schoolCode')!;

      const result = await updateSubject(c.env, schoolCode, id, data);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.delete(
  '/:id',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      const schoolCode = c.get('schoolCode')!;

      const result = await deleteSubject(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Assign Subject to Class ====================
const assignToClassSchema = z.object({
  classSectionId: z.number(),
  subjectId: z.number(),
  isMandatory: z.boolean().default(true),
});

subjectsRouter.post(
  '/assign-class-section',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator('json', assignToClassSchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const schoolCode = c.get('schoolCode')!;

      const result = await assignSubjectToClass(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Subjects for a Class-Section ====================
subjectsRouter.get(
 '/class-subjects/:classSectionId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const classSectionId = parseInt(c.req.param('classSectionId'));
      const schoolCode = c.get('schoolCode')!;

      const subjects = await getClassSectionSubjects(c.env, schoolCode, classSectionId);

      return c.json({ subjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get All Teachers ====================
subjectsRouter.get(
  '/teachers',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  async (c) => {
    try {
      const schoolCode = c.get('schoolCode')!;
      const teachers = await getTeachers(c.env, schoolCode);  // ← NEW: Call service
      return c.json({ teachers });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get Teachers for Class-Subject ====================
subjectsRouter.get(
  '/class-subject-teachers/:classSubjectId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const classSubjectId = parseInt(c.req.param('classSubjectId'));
      const schoolCode = c.get('schoolCode')!;
      const assignments = await getClassSubjectTeachers(c.env, schoolCode, classSubjectId);  // ← NEW
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Unassign Teacher from Subject ====================
subjectsRouter.delete(
  '/unassign-teacher/:assignmentId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const assignmentId = parseInt(c.req.param('assignmentId'));
      const schoolCode = c.get('schoolCode')!;
      const result = await unassignTeacherFromSubject(c.env, schoolCode, assignmentId);  // ← NEW
      return c.json(result);
    } catch (error: any) {
      console.error('Unassign teacher error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get All Class-Subjects (NEW for select dialog) ====================
subjectsRouter.get(
  '/all-class-subjects',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const schoolCode = c.get('schoolCode')!;
      const classSubjects = await getAllClassSubjects(c.env, schoolCode);  // ← NEW
      return c.json({ classSubjects });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Assign Teacher to Subject/Class ====================
const assignTeacherSchema = z.object({
  teacherId: z.number(),
  classSubjectId: z.number(),
  isPrimary: z.boolean().default(false),
});

subjectsRouter.post(
  '/assign-teacher',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator('json', assignTeacherSchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const schoolCode = c.get('schoolCode')!;

      const result = await assignTeacherToSubject(c.env, schoolCode, data);

      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

subjectsRouter.get(
  '/teacher-assignments/:teacherId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const teacherId = parseInt(c.req.param('teacherId'));
      const schoolCode = c.get('schoolCode')!;

      const assignments = await getTeacherAssignments(c.env, schoolCode, teacherId);

      console.log('Teacher assignments:', assignments);  // ← NEW: Log assignments for debugging

      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get Single Class Subject by ID (NEW) ====================
subjectsRouter.get(
  '/class-subject/:classSubjectId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    try {
      const classSubjectId = parseInt(c.req.param('classSubjectId'));
      const schoolCode = c.get('schoolCode')!;

      const classSubject = await getClassSubjectById(c.env, schoolCode, classSubjectId);
      return c.json({ classSubject });
    } catch (error: any) {
      console.error('Get class subject error:', error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Unassign Subject from Class (NEW) ====================
subjectsRouter.delete(
  '/unassign-class/:classSubjectId',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const classSubjectId = parseInt(c.req.param('classSubjectId'));
      const schoolCode = c.get('schoolCode')!;

      const result = await unassignSubjectFromClass(c.env, schoolCode, classSubjectId);  // ← NEW: Call service

      return c.json(result);
    } catch (error: any) {
      console.error('Unassign error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

export default subjectsRouter;