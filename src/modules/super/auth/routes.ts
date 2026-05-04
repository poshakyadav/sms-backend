import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
} from "../../../middleware/super-auth";
import {
  registerSuperUser,
  loginSuperUser,
  generateSuperTokens,
  refreshSuperAccessToken,
  logoutSuperUser,
} from "./services";
import { getSuperUserPermissionsFromDB } from "./permission-helpers";
import forgotPasswordRouter from "./forgot-password/forgot-password.routes";

const authRouter = new Hono<Env>();

// ── Mount forgot-password sub-router ─────────────────────────────────────────
// Routes exposed:
//   POST /auth/forgot-password
//   POST /auth/forgot-password/verify
//   POST /auth/forgot-password/reset
authRouter.route("/forgot-password", forgotPasswordRouter); 

// ── Register ──────────────────────────────────────────────────────────────────
authRouter.post(
  "/register",
  zValidator(
    "json",
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      roleId: z.number().int().positive().optional(),
    })
  ),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const db = getCommonDB(c.env);

      const newUser = await registerSuperUser(db, data);
      const permissions = await getSuperUserPermissionsFromDB(db, newUser.id);

      const { access_token, refresh_token } = await generateSuperTokens(
        db,
        {
          id: newUser.id,
          name: newUser.name,
          permissions: permissions as string[],
          tokenVersion: newUser.tokenVersion,
        },
        c.env.JWT_SECRET
      );

      return c.json(
        {
          access_token,
          refresh_token,
          user: { id: newUser.id, name: newUser.name },
        },
        201
      );
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── Login ─────────────────────────────────────────────────────────────────────
authRouter.post(
  "/login",
  zValidator(
    "json",
    z.object({ email: z.string().email(), password: z.string().min(1) })
  ),
  async (c) => {
    try {
      const { email, password } = c.req.valid("json");
      const db = getCommonDB(c.env);

      const user = await loginSuperUser(db, email, password);
      const permissions = await getSuperUserPermissionsFromDB(db, user.id);

      const { access_token, refresh_token } = await generateSuperTokens(
        db,
        {
          id: user.id,
          name: user.name,
          permissions: permissions as string[],
          tokenVersion: user.tokenVersion,
        },
        c.env.JWT_SECRET
      );

      return c.json({
        access_token,
        refresh_token,
        user: { id: user.id, name: user.name },
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 401);
    }
  }
);

// ── Refresh ───────────────────────────────────────────────────────────────────
authRouter.post(
  "/refresh",
  zValidator("json", z.object({ refresh_token: z.string() })),
  async (c) => {
    try {
      const { refresh_token } = c.req.valid("json");
      const db = getCommonDB(c.env);
      const tokens = await refreshSuperAccessToken(
        db,
        refresh_token,
        c.env.JWT_SECRET
      );
      return c.json(tokens);
    } catch (error: any) {
      return c.json({ error: error.message }, 401);
    }
  }
);

// ── Logout ────────────────────────────────────────────────────────────────────
authRouter.post(
  "/logout",
  jwtMiddleware,
  superTokenValidationMiddleware,
  zValidator("json", z.object({ refresh_token: z.string() })),
  async (c) => {
    try {
      const { refresh_token } = c.req.valid("json");
      const user = c.get("superUser")!;
      const db = getCommonDB(c.env);
      await logoutSuperUser(db, refresh_token, user.id);
      return c.json({ message: "Logged out successfully" });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default authRouter;
