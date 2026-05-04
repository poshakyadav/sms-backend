// …/school/info/routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION-GRADE school info routes
// GET  /school/info          → all authenticated users (branding data)
// PUT  /school/info          → settings.manage permission only
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getSchoolInfo, updateSchoolInfo } from "./services";

const schoolInfoRouter = new Hono<SchoolEnv>();

schoolInfoRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== GET SCHOOL INFO ====================
/**
 * GET /school/info
 * Returns school details incl. shortName.
 * Available to ALL authenticated users (needed for header/branding).
 */
schoolInfoRouter.get("/", async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const info = await getSchoolInfo(c.env, schoolCode);
    if (!info) {
      return c.json({ success: false, error: "School info not found" }, 404);
    }
    return c.json({ success: true, school: info });
  } catch (error: any) {
    console.error("Get school info error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== UPDATE SCHOOL INFO ====================
const updateSchoolInfoSchema = z.object({
  name: z.string().min(3).max(200).optional(),

  // ── NEW: shortName — branding label shown in header/sidebar ──────────────
  // Max 8 chars. School chooses it themselves (e.g. "DPS", "RYAN", "KENDRIYA").
  // Frontend sends trimmed string; service additionally slices to 8 chars.
  shortName: z
    .string()
    .max(8, "Short name must be 8 characters or less")
    .regex(
      /^[A-Za-z0-9 \-\.]+$/,
      "Only letters, numbers, spaces, hyphens and dots allowed"
    )
    .optional()
    .or(z.literal("")),

  addressLineOne: z.string().max(255).optional(),
  addressLineTwo: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  alternatePhone: z.string().max(20).optional(),
  email: z.string().email().optional().or(z.literal("")),
  website: z.string().url().optional().or(z.literal("")),
  logoUrl: z.string().url().optional().or(z.literal("")),
  tagline: z.string().max(300).optional().or(z.literal("")),
});

/**
 * PUT /school/info
 * Updates school details + shortName. Requires "settings.manage" permission.
 */
schoolInfoRouter.put(
  "/",
  requirePermission("settings.manage"),
  zValidator("json", updateSchoolInfoSchema),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const data = c.req.valid("json");

      await updateSchoolInfo(c.env, schoolCode, data);

      return c.json({
        success: true,
        message: "School information updated successfully",
      });
    } catch (error: any) {
      console.error("Update school info error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Failed to update school info",
        },
        400
      );
    }
  }
);

export default schoolInfoRouter;
