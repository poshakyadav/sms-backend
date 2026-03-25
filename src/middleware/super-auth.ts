import { jwt } from "hono/jwt";
import { createMiddleware } from "hono/factory";
import { Context } from "hono"; // Added this import for proper Context typing
import { eq } from "drizzle-orm"; // Removed 'and' since it's not used here
import { userPermissionsSchema } from "../db/schemas/super/user-permissions";
import {
  defaultPermissions,
  Permission,
  PermissionFlags,
} from "../types/permissions";
import { Env } from "../types/common-types";
import { SuperRole } from "../types/super-role";
import { getCommonDB } from "../db";

export const jwtMiddleware = createMiddleware<Env>(async (c, next) => {
  // Dynamically create the JWT middleware per request to access c.env
  const tokenMiddleware = jwt({
    secret: c.env.JWT_SECRET, // Now a static string, resolved from c.env
    alg: "HS256", // Optional, but kept
  });

  // Call the created middleware
  return tokenMiddleware(c, next);
});

export const permissionMiddleware = (requiredPermissions: Permission[]) =>
  createMiddleware(async (c, next) => {
    const payload = c.get("jwtPayload");
    if (!payload) return c.json({ error: "Unauthorized" }, 401);

    const db = getCommonDB(c.env);

    // Load user's permissions from DB
    const dbPermissions = await db
      .select()
      .from(userPermissionsSchema)
      .where(eq(userPermissionsSchema.userId, parseInt(payload.sub)))
      .all();
    const permMap: Partial<PermissionFlags> = {};
    dbPermissions.forEach((p) => {
      permMap[p.permission] = p.allowed;
    });

    // Merge with defaults
    const defaults = defaultPermissions[payload.role as SuperRole] || {};
    const effective: PermissionFlags = { ...defaults, ...permMap };

    const hasAll = requiredPermissions.every((perm) => effective[perm]);
    if (!hasAll) return c.json({ error: "Forbidden" }, 403);

    c.set("userPermissions", effective);
    c.set("user", { id: parseInt(payload.sub), role: payload.role }); // For convenience
    await next();
  });
