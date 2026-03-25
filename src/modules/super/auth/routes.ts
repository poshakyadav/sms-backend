// src/modules/auth/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { registerUser, loginUser, generateTokens, refreshAccessToken, logoutUser } from './services';
import { Env } from '../../../types/common-types';
import { jwtMiddleware } from '../../../middleware/super-auth';
import { SuperRole } from '../../../types/super-role';
import { getCommonDB } from '../../../db';

const authRouter = new Hono<Env>();

const registerSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(Object.values(SuperRole)).optional(),
});
authRouter.post('/register', zValidator('json', registerSchema), async (c) => {
  try {
    const data = c.req.valid('json');
    const db = getCommonDB(c.env);
    const newUser = await registerUser( db, data);
    const { access_token, refresh_token } = await generateTokens(db, newUser, c.env.JWT_SECRET);
    return c.json({
      access_token,
      refresh_token,
      user: { id: newUser.id, name: newUser.name, role: newUser.role },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });
authRouter.post('/login', zValidator('json', loginSchema), async (c) => {
  try {
    const { email, password } = c.req.valid('json');
    const db = getCommonDB(c.env);
    const user = await loginUser(db, email, password);
    const { access_token, refresh_token } = await generateTokens(db, user, c.env.JWT_SECRET);
    return c.json({
      access_token,
      refresh_token,
      user: { id: user.id, name: user.name, role: user.role },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 401);
  }
});

const refreshSchema = z.object({ refresh_token: z.string() });
authRouter.post('/refresh', zValidator('json', refreshSchema), async (c) => {
  try {
    const { refresh_token } = c.req.valid('json');
    const db = getCommonDB(c.env);
    const { access_token, user } = await refreshAccessToken(db, refresh_token, c.env.JWT_SECRET);
    return c.json({
      access_token,
      refresh_token,  // Reuse or rotate if needed
      user: { id: user.id, name: user.name, role: user.role },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 401);
  }
});

const logoutSchema = z.object({ refresh_token: z.string() });
authRouter.post('/logout', jwtMiddleware, zValidator('json', logoutSchema), async (c) => {
  try {
    const { refresh_token } = c.req.valid('json');
    const db = getCommonDB(c.env);
    
    // Get user ID from JWT payload (set by jwtMiddleware)
    const payload = c.get('jwtPayload');
    if (!payload || !payload.sub) {
      return c.json({ error: 'Invalid authentication' }, 401);
    }
    const userId = parseInt(payload.sub);

    // Pass userId for security check
    await logoutUser(db, refresh_token, userId);
    
    return c.json({ message: 'Logged out successfully' });
  } catch (error: any) {
    return c.json({ error: error.message || 'Logout failed' }, 400);
  }
});

export default authRouter;