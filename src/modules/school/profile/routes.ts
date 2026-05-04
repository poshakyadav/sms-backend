// …/school/profile/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  changeMyEmail,
} from "./services";

const profileRouter = new Hono<SchoolEnv>();

// ── Auth middleware on all routes ─────────────────────────────────────────────
profileRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== GET MY PROFILE ====================
/**
 * GET /school/profile/me
 * Returns the full profile of the currently authenticated user.
 * Works for ALL roles — student, teacher, parent, staff, owner, etc.
 */
profileRouter.get("/me", async (c) => {
  try {
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;

    const profile = await getMyProfile(c.env, schoolCode, user.id);

    if (!profile) {
      return c.json({ success: false, error: "Profile not found" }, 404);
    }

    // ── Expose whether the caller has edit capability ──────────────────────
    // The frontend uses this flag to decide whether to show edit controls.
    // We check the permission that's already decoded in the JWT — no extra DB call.
    const permissions: string[] = user.permissions ?? [];
    const canEditProfile =
      permissions.includes("*") || permissions.includes("users.edit");

    return c.json({ success: true, profile, canEditProfile });
  } catch (error: any) {
    console.error("Get profile error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== UPDATE MY PROFILE ====================
/**
 * PUT /school/profile/me
 *
 * PERMISSION GATE: requires `users.edit` (or wildcard `*`).
 *
 * Why? In a school context, students / parents / lower-staff must NOT be able
 * to self-edit sensitive fields (name, DOB, address, blood group, etc.).
 * If they need a change they visit the school office; a staff member with
 * `users.edit` makes the update on their behalf (or they can use the
 * /school/users/:id endpoint directly).
 *
 * Password and email changes use separate, dedicated endpoints that remain
 * available to every authenticated user.
 */
const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z.string().min(10).max(15).optional().or(z.literal("")),
  alternatePhone: z.string().min(10).max(15).optional().or(z.literal("")),
  dateOfBirth: z.string().date().optional().or(z.literal("")),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional().or(z.literal("")),
  bloodGroup: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional()
    .or(z.literal("")),
  avatarUrl: z.string().url().optional().or(z.literal("")),
  addressLineOne: z.string().max(255).optional().or(z.literal("")),
  addressLineTwo: z.string().max(255).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  postalCode: z.string().max(20).optional().or(z.literal("")),
});

profileRouter.put("/me", zValidator("json", updateProfileSchema), async (c) => {
  try {
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;

    // ── Permission check ───────────────────────────────────────────────────
    // Only users with `users.edit` (or wildcard `*`) may update profile data.
    // This mirrors the same permission used on the /school/users/:id endpoint.
    const permissions: string[] = user.permissions ?? [];
    const canEdit =
      permissions.includes("*") || permissions.includes("users.edit");

    if (!canEdit) {
      return c.json(
        {
          success: false,
          error:
            "You do not have permission to edit profile information. " +
            "Please contact the school office to request changes.",
        },
        403
      );
    }

    const data = c.req.valid("json");
    await updateMyProfile(c.env, schoolCode, user.id, data);

    return c.json({ success: true, message: "Profile updated successfully" });
  } catch (error: any) {
    console.error("Update profile error:", error);
    return c.json(
      { success: false, error: error.message || "Failed to update profile" },
      400
    );
  }
});

// ==================== CHANGE PASSWORD ====================
/**
 * PUT /school/profile/me/change-password
 *
 * Available to ALL authenticated school users (no special permission needed).
 * Every user owns their own password — even students and parents.
 */
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters")
      .max(100),
    confirmPassword: z.string().min(1, "Confirm password is required"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

profileRouter.put(
  "/me/change-password",
  zValidator("json", changePasswordSchema),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const { currentPassword, newPassword } = c.req.valid("json");

      await changeMyPassword(
        c.env,
        schoolCode,
        user.id,
        currentPassword,
        newPassword
      );

      return c.json({
        success: true,
        message:
          "Password changed successfully. Please log in again with your new password.",
      });
    } catch (error: any) {
      console.error("Change password error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to change password" },
        400
      );
    }
  }
);

// ==================== CHANGE EMAIL ====================
/**
 * PUT /school/profile/me/change-email
 *
 * Available to ALL authenticated school users (no special permission needed).
 * Every user owns their own email — even students and parents.
 * Requires current password verification as a security gate.
 */
const changeEmailSchema = z.object({
  newEmail: z
    .string()
    .email("Invalid email address")
    .transform((val) => val.toLowerCase().trim()),
  currentPassword: z.string().min(1, "Password is required to change email"),
});

profileRouter.put(
  "/me/change-email",
  zValidator("json", changeEmailSchema),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const { newEmail, currentPassword } = c.req.valid("json");

      await changeMyEmail(
        c.env,
        schoolCode,
        user.id,
        newEmail,
        currentPassword
      );

      return c.json({
        success: true,
        message:
          "Email changed successfully. Please log in again with your new email.",
      });
    } catch (error: any) {
      console.error("Change email error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to change email" },
        400
      );
    }
  }
);

export default profileRouter;
