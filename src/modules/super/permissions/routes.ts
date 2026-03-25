// src/modules/permissions/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { updateUserPermission, getUserPermissions } from './services';
import { jwtMiddleware, permissionMiddleware } from '../../../middleware/super-auth';
import { Env } from '../../../types/common-types';
import { Permission } from '../../../types/permissions';
import { getCommonDB } from '../../../db';

const permissionsRouter = new Hono<Env>();

permissionsRouter.use('*', jwtMiddleware, permissionMiddleware(['canManagePermissions']));

const updateSchema = z.object({
  userId: z.number(),
  permission: z.string(),  // Validate against Permission if needed
  allowed: z.boolean(),
});
permissionsRouter.post('/update', zValidator('json', updateSchema), async (c) => {
  try {
    const { userId, permission, allowed } = c.req.valid('json');
    const db = getCommonDB(c.env);
    await updateUserPermission(db, userId, permission as Permission, allowed);
    return c.json({ message: 'Permission updated' });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

permissionsRouter.get('/:userId', async (c) => {
  try {
    const userId = parseInt(c.req.param('userId'));
    const db = getCommonDB(c.env);
    const perms = await getUserPermissions(db, userId);
    return c.json(perms);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default permissionsRouter;