// src/middleware/require-active-access.ts
//
// Drop this middleware onto any school router (or specific routes) that should
// be blocked when the school's access subscription has lapsed.
//
// Usage in a school router:
//   import { requireActiveAccess } from "../../../middleware/require-active-access";
//   schoolFeeRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware, requireActiveAccess);
//
// The middleware is INTENTIONALLY separate from schoolJwtMiddleware so you can
// choose which routes are gated. For example, the billing/payment routes must
// remain accessible even when access has lapsed (so the school can renew).

import { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { getCommonDB } from "../db";
import { schoolsSchema } from "../db/schemas/super";
import { getSchoolAccessStatus } from "../utils/access-periods";
import { SchoolEnv } from "../types/common-types";

/**
 * Reads the schoolCode from JWT context, looks up the school's latest
 * `school_access_periods.expiresAt`, and either lets the request through or
 * returns a 402 Payment Required with a structured body the Angular app can
 * use to redirect the user to the billing/renewal page.
 *
 * This is a READ-ONLY check — it never modifies any data.
 */
export async function requireActiveAccess(
  c: Context<SchoolEnv>,
  next: Next
): Promise<Response | void> {
  try {
    const schoolCode = c.get("schoolCode");
    if (!schoolCode) {
      return c.json(
        { success: false, error: "School code missing from context" },
        401
      );
    }

    const db = getCommonDB(c.env as any);

    // Resolve school id from code — cheap indexed lookup.
    const school = await db
      .select({ id: schoolsSchema.id, isActive: schoolsSchema.isActive })
      .from(schoolsSchema)
      .where(eq(schoolsSchema.uniqueCode, schoolCode))
      .get();

    if (!school) {
      return c.json({ success: false, error: "School not found" }, 404);
    }

    if (!school.isActive) {
      return c.json(
        {
          success: false,
          error: "School account is suspended. Please contact support.",
          code: "SCHOOL_SUSPENDED",
        },
        403
      );
    }

    const { hasAccess, expiresAt, daysRemaining } = await getSchoolAccessStatus(
      db,
      school.id
    );

    if (!hasAccess) {
      return c.json(
        {
          success: false,
          error:
            "Your access subscription has expired. Please renew to continue.",
          code: "ACCESS_EXPIRED",
          expiresAt,
          renewUrl: "/school/billing",
        },
        402
      );
    }

    // Optionally warn if expiry is within 7 days — Angular can surface a
    // "renew soon" banner without blocking the request.
    if (daysRemaining <= 7) {
      c.header("X-Access-Expires-In-Days", String(daysRemaining));
    }

    await next();
  } catch (error: any) {
    console.error("requireActiveAccess error:", error);
    return c.json(
      { success: false, error: "Access check failed. Please try again." },
      500
    );
  }
}
