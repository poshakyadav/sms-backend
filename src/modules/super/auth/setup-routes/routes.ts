import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../../types/common-types";
import { getCommonDB } from "../../../../db";
import { bootstrapSuperAdmin, checkSetupRequired } from "./services";
import { getSuperUserPermissionsFromDB } from "../permission-helpers";
import { generateSuperTokens } from "../services";

const setupRouter = new Hono<Env>();

/**
 * GET /auth/setup/status
 * Returns whether initial setup is still required.
 * Safe to call unauthenticated — reveals only a boolean.
 */
setupRouter.get("/status", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const required = await checkSetupRequired(db);
    return c.json({ setupRequired: required });
  } catch (error: any) {
    return c.json({ error: "Failed to check setup status" }, 500);
  }
});

/**
 * POST /auth/setup
 * One-time bootstrap: creates the primary SUPERADMIN.
 * Returns 404 forever once any super user exists.
 *
 * Body: { name, email, password, confirmPassword }
 */
setupRouter.post(
  "/",
  zValidator(
    "json",
    z
      .object({
        name: z.string().min(2, "Name must be at least 2 characters"),
        email: z.string().email("Invalid email address"),
        password: z
          .string()
          .min(8, "Password must be at least 8 characters")
          .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
          .regex(/[0-9]/, "Password must contain at least one number")
          .regex(
            /[^A-Za-z0-9]/,
            "Password must contain at least one special character"
          ),
        confirmPassword: z.string(),
      })
      .refine((d) => d.password === d.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
      })
  ),
  async (c) => {
    try {
      const db = getCommonDB(c.env);

      // Hard gate — if any user exists, this endpoint is gone forever
      const setupRequired = await checkSetupRequired(db);
      if (!setupRequired) {
        return c.json({ error: "Not Found" }, 404);
      }

      const { name, email, password } = c.req.valid("json");
      const newUser = await bootstrapSuperAdmin(db, { name, email, password });

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
          message: "Primary super admin created successfully",
        },
        201
      );
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default setupRouter;
