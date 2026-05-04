import { Hono } from "hono";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { getDashboardStats } from "./services";

const superDashboardRouter = new Hono<Env>();

// Both JWT verification and token validation are required —
// the old code only ran jwtMiddleware so c.get("superUser") was never set.
superDashboardRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

superDashboardRouter.get(
  "/stats",
  requireSuperPermission("dashboard.view"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const stats = await getDashboardStats(db);
      return c.json({ success: true, stats });
    } catch (error: any) {
      console.error("Dashboard stats error:", error);
      return c.json({ success: false, error: "Failed to load dashboard stats" }, 500);
    }
  }
);

export default superDashboardRouter;