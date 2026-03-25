import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { schoolJwtMiddleware, schoolTokenValidationMiddleware, schoolPermissionMiddleware } from '../../../middleware/school-auth';
import { SchoolEnv } from '../../../types/common-types';
import { SchoolRole } from '../../../types/school-role';
import { markAttendance, getAttendanceByStudent, getAttendanceByClass, getAttendanceReport } from './services';
const attendanceRouter = new Hono<SchoolEnv>();

attendanceRouter.use('*', schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Mark Attendance (Batch for Class/Section) ====================
const markAttendanceSchema = z.object({
  date: z.string().date(), // "2026-02-14"
  classSectionId: z.number(),
  attendances: z.array(z.object({
    studentId: z.number(),
    status: z.enum(["PRESENT", "ABSENT", "LATE", "HALF_DAY"]),
    notes: z.string().optional(),
  })),
});

attendanceRouter.post(
  '/',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.TEACHER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  zValidator('json', markAttendanceSchema),
  async (c) => {
    try {
      const data = c.req.valid('json');
      const user = c.get('user')!;
      const schoolCode = c.get('schoolCode')!;

      const result = await markAttendance(c.env, schoolCode, data, user.id);

      return c.json(result, 201);
    } catch (error: any) {
      console.error('Attendance marking error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance by Student ====================
const studentAttendanceSchema = z.object({
  studentId: z.coerce.number(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
});

attendanceRouter.get(
  '/student',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER, SchoolRole.STUDENT_PARENT]),
  zValidator('query', studentAttendanceSchema),
  async (c) => {
    try {
      const { studentId, fromDate, toDate } = c.req.valid('query');
      const schoolCode = c.get('schoolCode')!;

      const attendance = await getAttendanceByStudent(c.env, schoolCode, studentId, fromDate, toDate);

      return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance by Class/Section/Date ====================
const classAttendanceSchema = z.object({
  classSectionId: z.coerce.number(),
  date: z.string().date(),
});

attendanceRouter.get(
  '/class',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  zValidator('query', classAttendanceSchema),
  async (c) => {
    try {
      const { classSectionId, date } = c.req.valid('query');
      const schoolCode = c.get('schoolCode')!;

      const attendance = await getAttendanceByClass(c.env, schoolCode, classSectionId, date);
    return c.json({ attendance });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Attendance Report (Monthly/Yearly Summary) ====================
const reportSchema = z.object({
  classSectionId: z.coerce.number().optional(),
  studentId: z.coerce.number().optional(),
  month: z.coerce.number().min(1).max(12).optional(), // For monthly report
  year: z.coerce.number().min(2000).max(2100).optional(),
});

attendanceRouter.get(
  '/report',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  zValidator('query', reportSchema),
  async (c) => {
    try {
      const data = c.req.valid('query');
      const schoolCode = c.get('schoolCode')!;
      console.log('Generating attendance report with params:', data);

      const report = await getAttendanceReport(c.env, schoolCode, data);

      return c.json({ report });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default attendanceRouter;