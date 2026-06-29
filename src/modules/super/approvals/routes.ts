// src/modules/super/approvals/routes.ts

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
  getPendingApprovals,
  getApprovalDetail,
  approvePayment,
  rejectPayment,
  getRazorpayApprovalQueue,
  activateRazorpaySchool,
} from "./services";

const approvalsRouter = new Hono<Env>();

approvalsRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY ACTIVATION QUEUE — new endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /approvals/razorpay
 * Returns schools that paid via Razorpay and are awaiting activation.
 *
 * Query params:
 *   includeActivated=true  → also return already-activated schools (history view)
 *
 * Response: { success: true, queue: RazorpayApprovalItem[], pendingCount: number }
 */
approvalsRouter.get(
  "/razorpay",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const includeActivated = c.req.query("includeActivated") === "true";

      const queue = await getRazorpayApprovalQueue(db, includeActivated);
      const pendingCount = queue.filter(
        (item) => item.activationStatus === "PENDING"
      ).length;

      return c.json({ success: true, queue, pendingCount });
    } catch (e: any) {
      console.error("GET /approvals/razorpay error:", e);
      return c.json({ success: false, error: e.message }, 500);
    }
  }
);

/**
 * POST /approvals/razorpay/:schoolId/activate
 * Activates a school that paid via Razorpay.
 *
 * Body: { internalNotes?: string }
 *
 * This endpoint:
 *   1. Verifies a CAPTURED setup fee payment exists in platform_payments
 *   2. Assigns a Turso DB and provisions it (users, roles, permissions, themes)
 *   3. Sets school.isActive = true and onboardingStatus = ACTIVE
 *   4. Sends the activation email to the school owner
 *
 * Idempotent — safe to call twice; second call is a no-op if already active.
 */
approvalsRouter.post(
  "/razorpay/:schoolId/activate",
  requireSuperPermission("schools.manage"),
  zValidator(
    "json",
    z.object({
      internalNotes: z.string().max(500).optional(),
    })
  ),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("schoolId"), 10);
      if (isNaN(schoolId)) {
        return c.json({ success: false, error: "Invalid school ID" }, 400);
      }

      const db = getCommonDB(c.env);
      const actor = c.get("superUser")!;
      const { internalNotes } = c.req.valid("json");

      const result = await activateRazorpaySchool(
        db,
        c.env,
        schoolId,
        actor.id,
        internalNotes
      );

      return c.json({
        success: true,
        message: `School "${result.schoolName}" has been activated. Login credentials emailed.`,
        schoolCode: result.schoolCode,
        schoolName: result.schoolName,
      });
    } catch (e: any) {
      console.error("POST /approvals/razorpay/:schoolId/activate error:", e);
      return c.json({ success: false, error: e.message }, 400);
    }
  }
);

// List all pending payment approvals
approvalsRouter.get(
  "/",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const approvals = await getPendingApprovals(db);
      return c.json({ success: true, approvals });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Get single approval detail
approvalsRouter.get(
  "/:paymentRecordId",
  requireSuperPermission("schools.manage"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const id = parseInt(c.req.param("paymentRecordId"));
      const detail = await getApprovalDetail(db, id);
      if (!detail) return c.json({ error: "Record not found" }, 404);
      return c.json({ success: true, detail });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  }
);

// Approve payment → activate school
approvalsRouter.post(
  "/:paymentRecordId/approve",
  requireSuperPermission("schools.manage"),
  zValidator(
    "json",
    z.object({
      internalNotes: z.string().optional(),
    })
  ),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const actor = c.get("superUser")!;
      const id = parseInt(c.req.param("paymentRecordId"));
      const { internalNotes } = c.req.valid("json");

      await approvePayment(db, c.env, id, actor.id, internalNotes);

      return c.json({
        success: true,
        message: "Payment approved. School is now active.",
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

// Reject payment
approvalsRouter.post(
  "/:paymentRecordId/reject",
  requireSuperPermission("schools.manage"),
  zValidator(
    "json",
    z.object({
      rejectionReason: z.string().min(5).max(500),
    })
  ),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const actor = c.get("superUser")!;
      const id = parseInt(c.req.param("paymentRecordId"));
      const { rejectionReason } = c.req.valid("json");

      await rejectPayment(db, c.env, id, actor.id, rejectionReason);

      return c.json({
        success: true,
        message: "Payment rejected. School has been notified.",
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  }
);

export default approvalsRouter;
