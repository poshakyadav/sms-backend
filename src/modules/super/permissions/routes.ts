import { Hono } from "hono";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { superPermissionsSchema } from "../../../db/schemas/super";
import { seedSuperPermissionsAndRoles } from "./services";
import { WILDCARD_PERMISSION } from "../../../types/super-permissions";

const permissionsRouter = new Hono<Env>();

permissionsRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// List all available super permissions (used by frontend to render permission checkboxes)
permissionsRouter.get(
  "/",
  requireSuperPermission("permissions.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const permissions = await db
        .select({
          id: superPermissionsSchema.id,
          slug: superPermissionsSchema.slug,
          name: superPermissionsSchema.name,
          description: superPermissionsSchema.description,
          module: superPermissionsSchema.module,
        })
        .from(superPermissionsSchema)
        .orderBy(superPermissionsSchema.module, superPermissionsSchema.slug)
        .all();
      return c.json({ success: true, permissions });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Trigger manual re-seed (superadmin only, useful in dev)
permissionsRouter.post("/seed", requireSuperPermission(WILDCARD_PERMISSION), async (c) => {
  try {
    const db = getCommonDB(c.env);
    await seedSuperPermissionsAndRoles(db);
    return c.json({ success: true, message: "Seeding complete" });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default permissionsRouter;
