import { Hono } from 'hono';
import { jwtMiddleware } from '../../../middleware/super-auth';
import { Env } from '../../../types/common-types';
import { getDashboardStats } from './services';
import { getCommonDB } from '../../../db';

const superDashboardRouter = new Hono<Env>();

superDashboardRouter.use('*', jwtMiddleware);

superDashboardRouter.get('/stats', async (c) => {
  try {
    const db = getCommonDB(c.env);
    const stats = await getDashboardStats(db);
    return c.json(stats);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default superDashboardRouter;