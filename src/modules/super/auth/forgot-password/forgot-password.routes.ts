// src/super/auth/forgot-password.routes.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../../types/common-types";
import { getCommonDB } from "../../../../db";
import {
  requestPasswordResetOtp,
  verifyResetOtp,
  resetPassword,
} from "./forgot-password.service";

const forgotPasswordRouter = new Hono<Env>();

// ── POST /auth/forgot-password  (Step 1 — request OTP) ───────────────────────
forgotPasswordRouter.post(
  "/",
  zValidator(
    "json",
    z.object({
      email: z.string().email("Please enter a valid email address"),
    })
  ),
  async (c) => {
    try {
      const { email } = c.req.valid("json");
      const db = getCommonDB(c.env);

      // Grab IP for audit log (CF Workers sets CF-Connecting-IP)
      const requestIp =
        c.req.header("CF-Connecting-IP") ??
        c.req.header("X-Forwarded-For") ??
        undefined;

      const result = await requestPasswordResetOtp(db, c.env, email, requestIp);
      return c.json(result);
    } catch (error: any) {
      // Never leak internal errors on this endpoint
      console.error("[forgot-password] error:", error);
      return c.json(
        {
          message:
            "If that email is registered, you will receive a reset code within a minute.",
        },
        200 // Always 200 — prevents email enumeration via status codes
      );
    }
  }
);

// ── POST /auth/forgot-password/verify  (Step 2 — verify OTP) ─────────────────
forgotPasswordRouter.post(
  "/verify",
  zValidator(
    "json",
    z.object({
      email: z.string().email(),
      otp: z
        .string()
        .length(6, "Code must be exactly 6 digits")
        .regex(/^\d{6}$/, "Code must contain only digits"),
    })
  ),
  async (c) => {
    try {
      const { email, otp } = c.req.valid("json");
      const db = getCommonDB(c.env);
      const result = await verifyResetOtp(db, email, otp);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ── POST /auth/forgot-password/reset  (Step 3 — set new password) ────────────
forgotPasswordRouter.post(
  "/reset",
  zValidator(
    "json",
    z
      .object({
        resetSessionToken: z.string().min(1),
        newPassword: z
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
      .refine((d) => d.newPassword === d.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
      })
  ),
  async (c) => {
    try {
      const { resetSessionToken, newPassword } = c.req.valid("json");
      const db = getCommonDB(c.env);
      const result = await resetPassword(db, resetSessionToken, newPassword);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default forgotPasswordRouter;
