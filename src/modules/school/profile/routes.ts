// …/school/profile/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getSchoolDB } from "../../../db/school-client";
import { schoolUsersSchema } from "../../../db/schemas/school";
import {
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
} from "../../../utils/school/username";
import {
  getMyProfile,
  updateMyProfile,
  changeMyPassword,
  changeMyEmail,
  changeMyUsername,
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

// ==================== CHECK USERNAME AVAILABILITY (SELF-SERVICE) ====================
/**
 * GET /school/profile/check-username?username=...
 *
 * Available to ALL authenticated users (no permission gate) — powers the
 * live availability check in the "Change Username" tab of My Profile.
 * Distinct from /school/users/check-username, which is gated by
 * users.create/users.edit and used by staff editing OTHER users.
 *
 * A caller's own current username is reported as "available" so the form
 * doesn't falsely flag their unchanged value as taken.
 */
profileRouter.get("/check-username", async (c) => {
  try {
    const raw = c.req.query("username");
    if (!raw) {
      return c.json(
        { success: false, error: "username query param is required" },
        400
      );
    }

    const username = normalizeUsername(raw);

    if (!USERNAME_REGEX.test(username)) {
      return c.json({
        success: true,
        available: false,
        message: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers.`,
      });
    }

    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);

    const existing = await db
      .select({ id: schoolUsersSchema.id })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.username, username))
      .get();

    // Own current username counts as "available" for the caller.
    const available = !existing || existing.id === user.id;

    return c.json({
      success: true,
      available,
      message: available
        ? "Username is available."
        : "This username is already taken. Please choose a different one.",
    });
  } catch (error: any) {
    console.error("Check username error:", error);
    return c.json(
      { success: false, error: error.message || "Server error" },
      500
    );
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
 * Username, password, and email changes use separate, dedicated endpoints
 * that remain available to every authenticated user.
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

// ==================== CHANGE USERNAME ====================
/**
 * PUT /school/profile/me/change-username
 *
 * Available to ALL authenticated school users (no special permission needed)
 * — same self-service model as change-password and change-email. Every user
 * owns their own username, including students and parents.
 *
 * Requires current password verification as a security gate, since the
 * username is a login credential.
 */
const changeUsernameSchema = z.object({
  username: z
    .string()
    .transform((val) => val.trim().toLowerCase())
    .refine((val) => USERNAME_REGEX.test(val), {
      message: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers (a-z, 0-9).`,
    }),
  currentPassword: z.string().min(1, "Current password is required"),
});

profileRouter.put(
  "/me/change-username",
  zValidator("json", changeUsernameSchema),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const { username, currentPassword } = c.req.valid("json");

      const result = await changeMyUsername(
        c.env,
        schoolCode,
        user.id,
        username,
        currentPassword
      );

      return c.json({
        success: true,
        message: "Username changed successfully.",
        username: result.username,
      });
    } catch (error: any) {
      console.error("Change username error:", error);
      const msg: string = error.message ?? "";
      const isTaken = msg.includes("already taken");
      return c.json(
        { success: false, error: msg || "Failed to change username" },
        isTaken ? 409 : 400
      );
    }
  }
);

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
 * Every user owns their own email — even students and parents. Since email
 * is now optional, this also covers a user adding an email for the first
 * time (their current email is simply null).
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