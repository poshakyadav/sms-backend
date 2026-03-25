import { jwt } from "hono/jwt";
import { createMiddleware } from "hono/factory";
import { SchoolEnv } from "../types/common-types";
import { SchoolRole } from "../types/school-role";

// ==================== 1. JWT Middleware (Simple, like super-auth) ====================
export const schoolJwtMiddleware = createMiddleware<SchoolEnv>(
  async (c, next) => {
    const tokenMiddleware = jwt({
      secret: c.env.JWT_SECRET,
      alg: "HS256",
    });

    // Pass next directly — no wrapping → no type error
    return tokenMiddleware(c, next);
  }
);

// ==================== 2. School Token Validation Middleware ====================
export const schoolTokenValidationMiddleware = createMiddleware<SchoolEnv>(
  async (c, next) => {
    const payload = c.get("jwtPayload");

    // If JWT failed or missing schoolCode → reject
    if (!payload || !payload.schoolCode || !payload.sub) {
      return c.json({ error: "Invalid or missing school token" }, 401);
    }

    // Set typed context variables (now safe because of SchoolEnv)
    c.set("schoolCode", payload.schoolCode);
    c.set("user", {
      id: parseInt(payload.sub),
      role: payload.role as SchoolRole,
      schoolCode: payload.schoolCode,
    });

    await next();
  }
);

// ==================== 3. Role-Based Permission Middleware ====================
export const schoolPermissionMiddleware = (allowedRoles: SchoolRole[]) =>
  createMiddleware<SchoolEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json({ error: "Forbidden: Insufficient role permissions" }, 403);
    }

    await next();
  });

// ==================== 4. Granular Creation Permission Helper ====================
export const canCreateRole = (
  creatorRole: SchoolRole,
  targetRole: SchoolRole
): boolean => {
  if (creatorRole === SchoolRole.SCHOOL_OWNER) return true;

  if ([SchoolRole.PRINCIPAL, SchoolRole.MANAGER].includes(creatorRole)) {
    return [
      SchoolRole.TEACHER,
      SchoolRole.STUDENT,
      SchoolRole.STUDENT_PARENT,
      SchoolRole.ADMISSION_OFFICER,
      SchoolRole.ACCOUNTANT,
      SchoolRole.LIBRARIAN,
      SchoolRole.TRANSPORT_STAFF,
      SchoolRole.SECURITY_STAFF,
      SchoolRole.CANTEEN_STAFF,
      SchoolRole.SCHOOL_NURSE,
    ].includes(targetRole);
  }

  if (creatorRole === SchoolRole.ADMISSION_OFFICER) {
    return targetRole === SchoolRole.STUDENT;
  }

  return false;
};
