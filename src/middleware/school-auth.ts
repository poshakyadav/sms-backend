// src/middleware/school-auth.ts

import { jwt } from "hono/jwt";
import { createMiddleware } from "hono/factory";
import { SchoolEnv } from "../types/common-types";
import { SchoolRole } from "../types/school-role";
import {
  SchoolPermissionSlug,
  WILDCARD_PERMISSION,
} from "../types/school-permissions";

// ==================== 1. JWT Middleware ====================
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

// ==================== 2. Token Validation Middleware (NO DB HITS) ====================
/**
 * PRODUCTION-GRADE: Zero database lookups per request.
 * Permissions live in JWT → blazing fast authorization.
 *
 * Token invalidation happens via tokenVersion:
 * - When roles change → tokenVersion++
 * - Old tokens fail at refresh endpoint (not here)
 */
export const schoolTokenValidationMiddleware = createMiddleware<SchoolEnv>(
  async (c, next) => {
    const payload = c.get("jwtPayload");

    if (!payload || !payload.schoolCode || !payload.sub) {
      return c.json({ error: "Invalid or missing school token" }, 401);
    }

    // Set user context from JWT (ZERO DB LOOKUPS)
    c.set("schoolCode", payload.schoolCode);
    c.set("user", {
      id: parseInt(payload.sub),
      name: payload.name ?? "",
      email: payload.email ?? "",
      username: payload.username ?? "", // mirrors generateSchoolAccessToken's payload
      schoolCode: payload.schoolCode,
      permissions: (payload.permissions || []) as string[],
      tokenVersion: payload.tokenVersion || 0,
      role: payload.role ?? "",
    });

    await next();
  }
);

/**
 * 3. Permission-Based Middleware
 * Usage: requirePermission("attendance.mark") or requirePermission(["users.list", "users.edit"])
 */
export const requirePermission = (
  required: SchoolPermissionSlug | SchoolPermissionSlug[]
) =>
  createMiddleware<SchoolEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const userPermissions = user.permissions || [];
    const requiredPerms = Array.isArray(required) ? required : [required];

    // Wildcard check (School Owner)
    if (userPermissions.includes(WILDCARD_PERMISSION)) {
      return next();
    }

    // Check if user has at least one required permission
    const hasPermission = requiredPerms.some((perm) =>
      userPermissions.includes(perm)
    );

    if (!hasPermission) {
      return c.json({ error: "Forbidden: Insufficient permissions" }, 403);
    }

    await next();
  });
