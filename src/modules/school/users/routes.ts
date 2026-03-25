// src/modules/school/users/routes.ts

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { schoolJwtMiddleware, schoolPermissionMiddleware, canCreateRole, schoolTokenValidationMiddleware } from '../../../middleware/school-auth';
import { SchoolEnv } from '../../../types/common-types';
import { SchoolRole } from '../../../types/school-role';
import { createSchoolUser, getSchoolUsers, getSchoolUserById, updateSchoolUser, deleteSchoolUser } from './services';

const usersRouter = new Hono<SchoolEnv>();

usersRouter.use('*', schoolJwtMiddleware, schoolTokenValidationMiddleware);

// GET All Users
usersRouter.get(
  '/',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  async (c) => {
    try {
      const schoolCode = c.get('schoolCode')!;
      const users = await getSchoolUsers(c.env, schoolCode);
      return c.json({ users });
    } catch (error: any) {
      console.error('Get users error:', error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// GET User by ID
usersRouter.get(
  '/:id',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      const schoolCode = c.get('schoolCode')!;
      const user = await getSchoolUserById(c.env, schoolCode, id);
      if (!user) return c.json({ error: 'User not found' }, 404);
      return c.json({ user });
    } catch (error: any) {
      console.error('Get user error:', error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// Create User Schema (Enhanced: Added split address fields)
const createUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  role: z.nativeEnum(SchoolRole),
  phone: z.string().min(10).max(15).optional(),
  alternatePhone: z.string().min(10).max(15).optional(),
  dateOfBirth: z.string().date().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  addressLineOne: z.string().max(255).optional(),
  addressLineTwo: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  avatarUrl: z.string().url().optional(),
  // Role-specific
  rollNumber: z.string().optional(), // Student
  admissionDate: z.string().date().optional(), // Student
  previousSchool: z.string().optional(), // Student
  medicalInfo: z.string().optional(), // Student
  qualification: z.string().optional(), // Teacher
  experienceYears: z.number().int().min(0).optional(), // Teacher
  joiningDate: z.string().date().optional(), // Teacher/Staff
  specialization: z.string().optional(), // Teacher
  occupation: z.string().optional(), // Parent
  department: z.string().optional(), // Staff
  salary: z.number().int().min(0).optional(), // Staff
  shift: z.string().optional(), // Staff
});

usersRouter.post(
  '/',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.ADMISSION_OFFICER]),
  zValidator('json', createUserSchema),
  async (c) => {
    try {
      const creator = c.get('user')!;
      const data = c.req.valid('json');
      if (!canCreateRole(creator.role, data.role)) {
        return c.json({ error: `You cannot create ${data.role} users` }, 403);
      }
      const schoolCode = c.get('schoolCode')!;
      const result = await createSchoolUser(c.env, schoolCode, data, creator.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error('Create user error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// Update User Schema (Partial for updates)
const updateUserSchema = createUserSchema.partial().omit({ password: true }); // Password separate if changing
updateUserSchema.extend({ newPassword: z.string().min(8).max(100).optional() });

usersRouter.put(
  '/:id',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  zValidator('json', updateUserSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      const data = c.req.valid('json');
      const updater = c.get('user')!;
      const schoolCode = c.get('schoolCode')!;
      const result = await updateSchoolUser(c.env, schoolCode, id, data, updater.id);
      return c.json(result);
    } catch (error: any) {
      console.error('Update user error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// DELETE User
usersRouter.delete(
  '/:id',
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      const deleter = c.get('user')!;
      if (id === deleter.id) return c.json({ error: 'Cannot delete yourself' }, 403);
      const schoolCode = c.get('schoolCode')!;
      const result = await deleteSchoolUser(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      console.error('Delete user error:', error);
      return c.json({ error: error.message }, 400);
    }
  }
);

export default usersRouter;