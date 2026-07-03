// src/modules/super/access-plans/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getAllAccessPlans, getAccessPlanByType, updateAccessPlan, seedAccessPlans } from "./services";

const accessPlansRouter = new Hono<Env>();

accessPlansRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ==================== GET ALL ====================
accessPlansRouter.get("/", requireSuperPermission("access-plans.view"), async (c) => {
  try {
    const plans = await getAllAccessPlans(c.env);
    return c.json({ success: true, plans });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== INITIALIZE (one-time seed, idempotent) ====================
// POST /super/access-plans/initialize
//
// Covers accounts created BEFORE the Razorpay integration existed — those
// super admins never went through registerSuperUser's seedRazorpayDefaults
// call, so their access_plans table is empty. This lets a super admin
// trigger the seed on-demand from the Access Plans screen instead of
// needing DB access. seedAccessPlans() is idempotent — safe to call even
// if rows already exist (no-ops and returns them as-is).
accessPlansRouter.post(
  "/initialize",
  requireSuperPermission("access-plans.manage"),
  async (c) => {
    try {
      await seedAccessPlans(c.env);
      // Re-fetch through getAllAccessPlans so the response includes
      // activeAutopaySubscriptions counts, same shape as GET /.
      const plans = await getAllAccessPlans(c.env);
      return c.json({
        success: true,
        message: "Access plans initialized successfully",
        plans,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET ONE ====================
accessPlansRouter.get("/:planType", requireSuperPermission("access-plans.view"), async (c) => {
  try {
    const planType = c.req.param("planType").toUpperCase() as "MONTHLY" | "YEARLY";
    if (!["MONTHLY", "YEARLY"].includes(planType)) {
      return c.json({ success: false, error: "Invalid plan type" }, 400);
    }
    const plan = await getAccessPlanByType(c.env, planType);
    if (!plan) return c.json({ success: false, error: "Plan not found" }, 404);
    return c.json({ success: true, plan });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== UPDATE ====================
// planType and durationDays are intentionally NOT editable here — see the
// comment on updateAccessPlan() in services.ts for why.
const updatePlanSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    amountPaise: z.number().int().positive().optional(),
    discountPaise: z.number().int().min(0).optional(),
    autopayEnabled: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

accessPlansRouter.put(
  "/:planType",
  requireSuperPermission("access-plans.manage"),
  zValidator("json", updatePlanSchema),
  async (c) => {
    try {
      const planType = c.req.param("planType").toUpperCase() as "MONTHLY" | "YEARLY";
      if (!["MONTHLY", "YEARLY"].includes(planType)) {
        return c.json({ success: false, error: "Invalid plan type" }, 400);
      }
      const data = c.req.valid("json");
      const result = await updateAccessPlan(c.env, planType, data);
      return c.json({
        success: true,
        message: "Access plan updated successfully",
        plan: result.plan,
        priceChanged: result.priceChanged,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message || "Failed to update plan" }, 400);
    }
  }
);

export default accessPlansRouter;