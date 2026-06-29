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
import {
  getAllAccessPlans,
  getAccessPlanByType,
  updateAccessPlanDiscount,
} from "./services";

const accessPlansRouter = new Hono<Env>();

accessPlansRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ==================== GET ALL ACCESS PLANS ====================
// Public-ish within super-admin auth — used by the pricing-management screen.
accessPlansRouter.get(
  "/",
  requireSuperPermission("access-plans.view"),
  async (c) => {
    try {
      const plans = await getAllAccessPlans(c.env);
      return c.json({ success: true, plans });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET ONE ACCESS PLAN ====================
accessPlansRouter.get(
  "/:planType",
  requireSuperPermission("access-plans.view"),
  async (c) => {
    try {
      const planType = c.req.param("planType").toUpperCase() as
        | "MONTHLY"
        | "YEARLY";
      if (!["MONTHLY", "YEARLY"].includes(planType)) {
        return c.json({ success: false, error: "Invalid plan type" }, 400);
      }

      const plan = await getAccessPlanByType(c.env, planType);
      if (!plan) {
        return c.json({ success: false, error: "Plan not found" }, 404);
      }

      return c.json({ success: true, plan });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== UPDATE ACCESS PLAN DISCOUNT ====================
const updatePlanSchema = z.object({
  discountPaise: z.number().int().min(0).optional(),
  autopayEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

accessPlansRouter.put(
  "/:planType",
  requireSuperPermission("access-plans.manage"),
  zValidator("json", updatePlanSchema),
  async (c) => {
    try {
      const planType = c.req.param("planType").toUpperCase() as
        | "MONTHLY"
        | "YEARLY";
      if (!["MONTHLY", "YEARLY"].includes(planType)) {
        return c.json({ success: false, error: "Invalid plan type" }, 400);
      }

      const data = c.req.valid("json");
      const updated = await updateAccessPlanDiscount(c.env, planType, data);

      return c.json({
        success: true,
        message: "Access plan updated successfully",
        plan: updated,
      });
    } catch (error: any) {
      return c.json(
        { success: false, error: error.message || "Failed to update plan" },
        400
      );
    }
  }
);

export default accessPlansRouter;
