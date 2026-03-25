// src/modules/school/dashboard/routes.ts

import { Hono } from "hono";
import {
  schoolJwtMiddleware,
  schoolPermissionMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolRole } from "../../../types/school-role";
import { getDashboardData } from "./services";
import { SchoolEnv } from "../../../types/common-types";

const schoolDashboardRouter = new Hono<SchoolEnv>();

// Apply authentication and token validation to all routes
schoolDashboardRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// Allow access to dashboard for specified roles (extend as needed)
schoolDashboardRouter.get(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.TEACHER,
    SchoolRole.STUDENT,
    SchoolRole.ACCOUNTANT, // Example staff
    SchoolRole.LIBRARIAN, // Add more staff designations
    // Add other roles like STUDENT_PARENT if needed
  ]),
  async (c) => {
    try {
      console.log(
        "Dashboard request received for school:",
        c.get("schoolCode"),
        "user:",
        c.get("user")?.id
      );
      const user = c.get("user"); // Assumes middleware sets this (id, role, etc.)
      const schoolCode = c.get("schoolCode")!;

      const data = await getDashboardData(c.env, schoolCode, user);

      return c.json(data);
    } catch (error: any) {
      console.error("Dashboard error:", error);
      return c.json({ error: error.message }, error.status || 500);
    }
  }
);

export default schoolDashboardRouter;
