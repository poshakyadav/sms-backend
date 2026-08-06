//  .../src/modules/school/settings/routes.ts

import { Hono } from "hono";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import { getSchoolDB } from "../../../db/school-client";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { schoolSettingsService } from "./services";
import { requirePermission, schoolJwtMiddleware, schoolTokenValidationMiddleware } from "../../../middleware/school-auth";

const schoolSettingsRouter = new Hono<SchoolEnv>();

// Apply common school auth middleware to all routes
schoolSettingsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Theme Management ====================

/**
 * GET /school/settings/theme
 * Returns the currently active theme for the school.
 * Available to ALL authenticated users (needed to render the app shell).
 */
schoolSettingsRouter.get("/theme", async (c) => {
  const schoolCode = c.get("schoolCode")!;
  const db = await getSchoolDB(c.env, schoolCode);
  const theme = await schoolSettingsService.getActiveTheme(db, schoolCode);
  return c.json({ success: true, theme });
});

/**
 * GET /school/settings/themes
 * Lists all predefined + custom themes for this school.
 * School owner uses this to browse and select themes.
 * "settings.manage" is only seeded for SCHOOL_OWNER.
 */
schoolSettingsRouter.get(
  "/themes",
  requirePermission("settings.manage"),
  async (c) => {
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);
    const themes = await schoolSettingsService.getAllThemes(db, schoolCode);
    return c.json({ success: true, themes });
  }
);

/**
 * POST /school/settings/theme/activate
 * Switches the active theme. Owner-only via "settings.manage".
 * (predefined or custom)
 */
schoolSettingsRouter.post(
  "/theme/activate",
  requirePermission("settings.manage"),
  zValidator("json", z.object({ themeId: z.number().int().positive() })),
  async (c) => {
    const { themeId } = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);
 
    const success = await schoolSettingsService.activateTheme(
      db,
      schoolCode,
      themeId
    );
 
    if (!success) {
      return c.json({ success: false, error: "Theme not found" }, 404);
    }
 
    return c.json({ success: true, message: "Theme activated successfully" });
  }
);

/**
 * POST /school/settings/theme/custom
 * Creates a new custom theme. Owner-only via "settings.manage".
 */
schoolSettingsRouter.post(
  "/theme/custom",
  requirePermission("settings.manage"),
  zValidator(
    "json",
    z.object({
      themeName: z.string().min(3).max(50),
      config: z.record(z.string(), z.string()),
    })
  ),
  async (c) => {
    const { themeName, config } = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);
 
    const newTheme = await schoolSettingsService.createCustomTheme(
      db,
      schoolCode,
      themeName,
      config
    );
    return c.json({ success: true, theme: newTheme }, 201);
  }
);

/**
 * DELETE /school/settings/theme/custom/:id
 * Deletes a custom theme. Cannot delete system/predefined themes.
 * Owner-only via "settings.manage".
 */
schoolSettingsRouter.delete(
  "/theme/custom/:id",
  requirePermission("settings.manage"),
  async (c) => {
    const themeId = parseInt(c.req.param("id"));
    if (isNaN(themeId)) {
      return c.json({ success: false, error: "Invalid theme ID" }, 400);
    }
 
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);
 
    try {
      await schoolSettingsService.deleteCustomTheme(db, schoolCode, themeId);
      return c.json({ success: true, message: "Theme deleted successfully" });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

export default schoolSettingsRouter;