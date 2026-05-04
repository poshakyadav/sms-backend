// src/modules/super/invitations/routes.ts

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
  createInvitation,
  getInvitations,
  getInvitationByToken,
  cancelInvitation,
  resendInvitation,
} from "./services";

const invitationsRouter = new Hono<Env>();

// ── Public: validate invite token (used by school signup page) ──────────────
invitationsRouter.get("/validate/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const db = getCommonDB(c.env);
    const invitation = await getInvitationByToken(db, token);

    if (!invitation) {
      return c.json({ valid: false, error: "Invitation not found" }, 404);
    }
    if (invitation.status === "EXPIRED" || invitation.status === "CANCELLED") {
      return c.json(
        { valid: false, error: "Invitation has expired or been cancelled" },
        410
      );
    }
    if (new Date(invitation.expiresAt) < new Date()) {
      return c.json(
        { valid: false, error: "Invitation link has expired" },
        410
      );
    }
    if (invitation.status === "PAYMENT_APPROVED") {
      return c.json({ valid: false, error: "School is already active" }, 409);
    }

    return c.json({
      valid: true,
      invitation: {
        schoolName: invitation.schoolName,
        schoolEmail: invitation.schoolEmail,
        schoolPhone: invitation.schoolPhone,
        city: invitation.city,
        status: invitation.status,
        schoolId: invitation.schoolId,
      },
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Protected routes ─────────────────────────────────────────────────────────
invitationsRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// List all invitations
invitationsRouter.get(
  "/",
  requireSuperPermission("schools.list"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const invitations = await getInvitations(db);
      return c.json({ success: true, invitations });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Create invitation — creates school record + sends invite email
invitationsRouter.post(
  "/",
  requireSuperPermission("schools.invite"),
  zValidator(
    "json",
    z.object({
      schoolName: z.string().min(2).max(200),
      schoolEmail: z.string().email(),
      schoolPhone: z.string().optional(),
      city: z.string().optional(),
      notes: z.string().optional(),
      expiryDays: z.number().int().min(1).max(90).default(30),
    })
  ),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const actor = c.get("superUser")!;
      const data = c.req.valid("json");

      const result = await createInvitation(db, c.env, {
        ...data,
        invitedBy: actor.id,
      });

      return c.json({ success: true, ...result }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Cancel invitation
invitationsRouter.post(
  "/:id/cancel",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const id = parseInt(c.req.param("id"));
      await cancelInvitation(db, id);
      return c.json({ success: true, message: "Invitation cancelled" });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Resend invite email
invitationsRouter.post(
  "/:id/resend",
  requireSuperPermission("schools.invite"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const id = parseInt(c.req.param("id"));
      const result = await resendInvitation(db, c.env, id);
      return c.json({ success: true, ...result });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

export default invitationsRouter;
