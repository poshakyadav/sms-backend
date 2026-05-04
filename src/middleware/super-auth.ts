import { jwt } from "hono/jwt";
import { createMiddleware } from "hono/factory";
import { Env } from "../types/common-types";
import {
  SuperPermissionSlug,
  WILDCARD_PERMISSION,
} from "../types/super-permissions";

// ── 1. JWT verification ───────────────────────────────────────────────────────

export const jwtMiddleware = createMiddleware<Env>(async (c, next) => {
  const tokenMiddleware = jwt({ secret: c.env.JWT_SECRET, alg: "HS256" });
  return tokenMiddleware(c, next);
});

// ── 2. Token validation — zero DB hits ───────────────────────────────────────

/**
 * Decodes the verified JWT payload and writes a typed user context into Hono's
 * variable store. No database calls — permissions live in the token.
 *
 * Token invalidation path:
 *   Role/permission change → tokenVersion++ in DB → client's next refresh picks
 *   up the new version and new permissions → old tokens eventually expire (15 min).
 */
export const superTokenValidationMiddleware = createMiddleware<Env>(
  async (c, next) => {
    const payload = c.get("jwtPayload");

    if (!payload?.sub) {
      return c.json({ error: "Invalid or missing token" }, 401);
    }

    c.set("superUser", {
      id: parseInt(payload.sub),
      name: payload.name as string,
      permissions: (payload.permissions || []) as string[],
      tokenVersion: (payload.tokenVersion as number) || 0,
    });

    await next();
  }
);

// ── 3. Permission guard ───────────────────────────────────────────────────────

/**
 * Usage:
 *   requireSuperPermission("users.create")
 *   requireSuperPermission(["schools.manage", "schools.invite"])
 *   requireSuperPermission(WILDCARD_PERMISSION)     // ← now allowed
 *   requireSuperPermission("*")                     // also works
 *
 * Any user who has the wildcard "*" in their token permissions will pass
 * immediately. Otherwise, at least one of the required slugs must be present.
 */

type PermissionRequirement = SuperPermissionSlug | typeof WILDCARD_PERMISSION;

export const requireSuperPermission = (
  // required: SuperPermissionSlug | SuperPermissionSlug[]
  required: PermissionRequirement | PermissionRequirement[]
) =>
  createMiddleware<Env>(async (c, next) => {
    const user = c.get("superUser");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const userPermissions: string[] = user.permissions || [];
    const requiredPerms = Array.isArray(required) ? required : [required];

    if (userPermissions.includes(WILDCARD_PERMISSION)) return next();

    const hasPermission = requiredPerms.some((p) => userPermissions.includes(p));
    if (!hasPermission) return c.json({ error: "Forbidden: insufficient permissions" }, 403);

    await next();
  });