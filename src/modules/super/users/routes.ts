// src/modules/users/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getUsers, getUserById, createUser, updateUser, deleteUser } from './services';
import { jwtMiddleware, permissionMiddleware } from '../../../middleware/super-auth';
import { Env } from '../../../types/common-types';
import { SuperRole } from '../../../types/super-role';
import { getCommonDB } from '../../../db';

const usersRouter = new Hono<Env>();

usersRouter.use('*', jwtMiddleware);

usersRouter.get('/', permissionMiddleware(['canViewUsers']), async (c) => {
  try {
    const db = getCommonDB(c.env);
    const users = await getUsers(db);
    return c.json(users);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

usersRouter.get('/:id', permissionMiddleware(['canViewUsers']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const db = getCommonDB(c.env);
    const user = await getUserById(db, id);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(user);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

const createSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(Object.values(SuperRole)),
});
usersRouter.post('/', permissionMiddleware(['canCreateUsers']), zValidator('json', createSchema), async (c) => {
  try {
    const data = c.req.valid('json');
    const db = getCommonDB(c.env);
    const newUser = await createUser(db, data);
    return c.json(newUser, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

const updateSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(Object.values(SuperRole)).optional(),
});
usersRouter.put('/:id', permissionMiddleware(['canUpdateUsers']), zValidator('json', updateSchema), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const data = c.req.valid('json');
    const db = getCommonDB(c.env);
    const updatedUser = await updateUser(db, id, data);
    return c.json(updatedUser);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

usersRouter.delete('/:id', permissionMiddleware(['canDeleteUsers']), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const db = getCommonDB(c.env);
    const deleted = await deleteUser(db, id);
    return c.json({ message: 'User deleted', user: deleted });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

export default usersRouter;