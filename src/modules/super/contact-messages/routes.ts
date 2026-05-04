// src/modules/super/contact-messages/routes.ts

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
  listContactMessages,
  getContactMessageById,
  updateContactStatus,
  updateContactNotes,
} from "./services";

const superContactMessagesRouter = new Hono<Env>();

superContactMessagesRouter.use(
  "/*",
  jwtMiddleware,
  superTokenValidationMiddleware
);

// ── List ──────────────────────────────────────────────────────────────────────
superContactMessagesRouter.get(
  "/",
  requireSuperPermission("contact-messages.view"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const status = c.req.query("status") || undefined;
      const category = c.req.query("category") || undefined;
      const messages = await listContactMessages(db, { status, category });
      return c.json({ success: true, messages });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Get single ────────────────────────────────────────────────────────────────
superContactMessagesRouter.get(
  "/:id",
  requireSuperPermission("contact-messages.view"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);
      const msg = await getContactMessageById(db, id);
      if (!msg) return c.json({ error: "Not found" }, 404);
      return c.json({ success: true, message: msg });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Update status ─────────────────────────────────────────────────────────────
superContactMessagesRouter.patch(
  "/:id/status",
  requireSuperPermission("contact-messages.manage"),
  zValidator(
    "json",
    z.object({
      status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"]),
    })
  ),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const { status } = c.req.valid("json");
      const superUser = c.get("superUser")!;
      const db = getCommonDB(c.env);
      await updateContactStatus(db, id, status, superUser.id);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── Update notes ──────────────────────────────────────────────────────────────
superContactMessagesRouter.patch(
  "/:id/notes",
  requireSuperPermission("contact-messages.manage"),
  zValidator("json", z.object({ internalNotes: z.string().max(2000) })),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const { internalNotes } = c.req.valid("json");
      const db = getCommonDB(c.env);
      await updateContactNotes(db, id, internalNotes);
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

export default superContactMessagesRouter;
