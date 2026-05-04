// src/modules/super/school-requests/routes.ts

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
  listRegistrationRequests,
  getRegistrationRequestById,
  updateRequestStatus,
  updateRequestNotes,
} from "./services";

const superSchoolRequestsRouter = new Hono<Env>();

// All routes require auth
superSchoolRequestsRouter.use(
  "/*",
  jwtMiddleware,
  superTokenValidationMiddleware
);

// ── List all registration requests ───────────────────────────────────────────
superSchoolRequestsRouter.get(
  "/",
  requireSuperPermission("school-requests.view"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const status = c.req.query("status") || undefined;
      const requests = await listRegistrationRequests(db, status);
      return c.json({ success: true, requests });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Get single request ────────────────────────────────────────────────────────
superSchoolRequestsRouter.get(
  "/:id",
  requireSuperPermission("school-requests.view"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);
      const request = await getRegistrationRequestById(db, id);

      if (!request) return c.json({ error: "Not found" }, 404);

      return c.json({ success: true, request });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Update status ─────────────────────────────────────────────────────────────
superSchoolRequestsRouter.patch(
  "/:id/status",
  requireSuperPermission("school-requests.manage"),
  zValidator(
    "json",
    z.object({
      status: z.enum([
        "PENDING",
        "REVIEWED",
        "INVITED",
        "REJECTED",
        "DUPLICATE",
      ]),
    })
  ),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const { status } = c.req.valid("json");
      const superUser = c.get("superUser")!;
      const db = getCommonDB(c.env);

      await updateRequestStatus(db, id, status, superUser.id);

      return c.json({ success: true, message: "Status updated" });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Update internal notes ─────────────────────────────────────────────────────
superSchoolRequestsRouter.patch(
  "/:id/notes",
  requireSuperPermission("school-requests.manage"),
  zValidator("json", z.object({ internalNotes: z.string().max(2000) })),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const { internalNotes } = c.req.valid("json");
      const db = getCommonDB(c.env);

      await updateRequestNotes(db, id, internalNotes);

      return c.json({ success: true, message: "Notes updated" });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

export default superSchoolRequestsRouter;
