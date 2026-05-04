import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import {
  getSuperUsers,
  getSuperUserById,
  createSuperUser,
  updateSuperUser,
  assignRolesToSuperUser,
  getSuperUserDirectPermissions,
  assignDirectPermissionsToSuperUser,
  deleteSuperUser,
} from "./services";

const usersRouter = new Hono<Env>();

usersRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// List
usersRouter.get("/", requireSuperPermission("users.list"), async (c) => {
  try {
    const users = await getSuperUsers(getCommonDB(c.env));
    return c.json({ success: true, users });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get by ID
usersRouter.get("/:id", requireSuperPermission("users.list"), async (c) => {
  try {
    const user = await getSuperUserById(
      getCommonDB(c.env),
      parseInt(c.req.param("id"))
    );
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ success: true, user });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Create
usersRouter.post(
  "/",
  requireSuperPermission("users.create"),
  zValidator(
    "json",
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      roleIds: z.array(z.number().int().positive()).min(1),
    })
  ),
  async (c) => {
    try {
      const user = await createSuperUser(
        getCommonDB(c.env),
        c.req.valid("json")
      );
      return c.json({ success: true, user }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Update
usersRouter.put(
  "/:id",
  requireSuperPermission("users.edit"),
  zValidator(
    "json",
    z.object({
      name: z.string().min(2).optional(),
      email: z.string().email().optional(),
      newPassword: z.string().min(8).optional(),
      isActive: z.boolean().optional(),
    })
  ),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const user = await updateSuperUser(
        getCommonDB(c.env),
        id,
        c.req.valid("json")
      );
      return c.json({ success: true, user });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Assign roles
usersRouter.put(
  "/:id/roles",
  requireSuperPermission("roles.manage"),
  zValidator(
    "json",
    z.object({ roleIds: z.array(z.number().int().positive()).min(1) })
  ),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      await assignRolesToSuperUser(
        getCommonDB(c.env),
        userId,
        c.req.valid("json").roleIds
      );
      return c.json({
        success: true,
        message: "Roles updated. User must log in again.",
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Get user direct permissions
usersRouter.get(
  "/:id/permissions",
  requireSuperPermission("permissions.manage"),
  async (c) => {
    try {
      const perms = await getSuperUserDirectPermissions(
        getCommonDB(c.env),
        parseInt(c.req.param("id"))
      );
      return c.json({ success: true, permissions: perms });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Assign direct permissions
usersRouter.put(
  "/:id/permissions",
  requireSuperPermission("permissions.manage"),
  zValidator(
    "json",
    z.object({ permissionIds: z.array(z.number().int().positive()) })
  ),
  async (c) => {
    try {
      const userId = parseInt(c.req.param("id"));
      await assignDirectPermissionsToSuperUser(
        getCommonDB(c.env),
        userId,
        c.req.valid("json").permissionIds
      );
      return c.json({ success: true, message: "Permissions updated." });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Delete — has TWO layers of protection:
//   1. Route level: cannot delete yourself
//   2. Service level: cannot delete any user with SUPERADMIN role
usersRouter.delete(
  "/:id",
  requireSuperPermission("users.delete"),
  async (c) => {
    try {
      const deleter = c.get("superUser")!;
      const id = parseInt(c.req.param("id"));
      if (id === deleter.id)
        return c.json({ error: "Cannot delete your own account" }, 403);
      await deleteSuperUser(getCommonDB(c.env), id);
      return c.json({ success: true, message: "User deleted" });
    } catch (e: any) {
      // Service throws a descriptive error for SUPERADMIN protection
      const status = e.message.includes("cannot be deleted") ? 403 : 400;
      return c.json({ error: e.message }, status);
    }
  }
);

export default usersRouter;
