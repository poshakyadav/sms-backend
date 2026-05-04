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
  getAllSuperRoles,
  getSuperRoleById,
  createSuperRole,
  updateSuperRole,
  deleteSuperRole,
} from "./services";

const superRolesRouter = new Hono<Env>();

superRolesRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

superRolesRouter.get("/", requireSuperPermission("roles.manage"), async (c) => {
  try {
    return c.json({ success: true, roles: await getAllSuperRoles(getCommonDB(c.env)) });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

superRolesRouter.get("/:id", requireSuperPermission("roles.manage"), async (c) => {
  try {
    const role = await getSuperRoleById(getCommonDB(c.env), parseInt(c.req.param("id")));
    if (!role) return c.json({ error: "Role not found" }, 404);
    return c.json({ success: true, role });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

superRolesRouter.post(
  "/",
  requireSuperPermission("roles.manage"),
  zValidator("json", z.object({
    name: z.string().min(2).max(80),
    description: z.string().min(5).max(300),
    permissionIds: z.array(z.number().int().positive()).min(1),
  })),
  async (c) => {
    try {
      const role = await createSuperRole(getCommonDB(c.env), c.req.valid("json"));
      return c.json({ success: true, role }, 201);
    } catch (e: any) { return c.json({ error: e.message }, 400); }
  }
);

superRolesRouter.put(
  "/:id",
  requireSuperPermission("roles.manage"),
  zValidator("json", z.object({
    name: z.string().min(2).max(80).optional(),
    description: z.string().min(5).max(300).optional(),
    permissionIds: z.array(z.number().int().positive()).optional(),
  })),
  async (c) => {
    try {
      await updateSuperRole(getCommonDB(c.env), parseInt(c.req.param("id")), c.req.valid("json"));
      return c.json({ success: true, message: "Role updated" });
    } catch (e: any) { return c.json({ error: e.message }, 400); }
  }
);

superRolesRouter.delete("/:id", requireSuperPermission("roles.manage"), async (c) => {
  try {
    await deleteSuperRole(getCommonDB(c.env), parseInt(c.req.param("id")));
    return c.json({ success: true, message: "Role deleted" });
  } catch (e: any) { return c.json({ error: e.message }, 400); }
});

export default superRolesRouter;