// src/modules/super/message-bundles/routes.ts

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
  getAllBundles,
  getBundleById,
  createBundle,
  updateBundle,
  deleteBundle,
} from "./services";

const messageBundlesRouter = new Hono<Env>();

messageBundlesRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ==================== GET ALL BUNDLES ====================
messageBundlesRouter.get(
  "/",
  requireSuperPermission("message-bundles.view"),
  async (c) => {
    try {
      const channel = c.req.query("channel") as
        | "WHATSAPP"
        | "EMAIL"
        | "SMS"
        | undefined;
      const bundles = await getAllBundles(c.env, channel);
      return c.json({ success: true, bundles });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET ONE BUNDLE ====================
messageBundlesRouter.get(
  "/:id",
  requireSuperPermission("message-bundles.view"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid bundle ID" }, 400);

      const bundle = await getBundleById(c.env, id);
      if (!bundle)
        return c.json({ success: false, error: "Bundle not found" }, 404);

      return c.json({ success: true, bundle });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== CREATE BUNDLE ====================
const createBundleSchema = z.object({
  channel: z.enum(["WHATSAPP", "EMAIL", "SMS"]),
  name: z.string().min(2).max(100),
  messageCount: z.number().int().positive(),
  amountPaise: z.number().int().positive(),
  discountPaise: z.number().int().min(0).optional(),
  validityDays: z.number().int().positive().optional(),
  sortOrder: z.number().int().optional(),
});

messageBundlesRouter.post(
  "/",
  requireSuperPermission("message-bundles.manage"),
  zValidator("json", createBundleSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const bundle = await createBundle(c.env, data);
      return c.json(
        { success: true, message: "Bundle created successfully", bundle },
        201
      );
    } catch (error: any) {
      return c.json(
        { success: false, error: error.message || "Failed to create bundle" },
        400
      );
    }
  }
);

// ==================== UPDATE BUNDLE ====================
const updateBundleSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  messageCount: z.number().int().positive().optional(),
  amountPaise: z.number().int().positive().optional(),
  discountPaise: z.number().int().min(0).optional(),
  validityDays: z.number().int().positive().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

messageBundlesRouter.put(
  "/:id",
  requireSuperPermission("message-bundles.manage"),
  zValidator("json", updateBundleSchema),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid bundle ID" }, 400);

      const data = c.req.valid("json");
      const bundle = await updateBundle(c.env, id, data);
      return c.json({
        success: true,
        message: "Bundle updated successfully",
        bundle,
      });
    } catch (error: any) {
      return c.json(
        { success: false, error: error.message || "Failed to update bundle" },
        400
      );
    }
  }
);

// ==================== DELETE (DEACTIVATE) BUNDLE ====================
messageBundlesRouter.delete(
  "/:id",
  requireSuperPermission("message-bundles.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid bundle ID" }, 400);

      const result = await deleteBundle(c.env, id);
      return c.json({ success: true, ...result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

export default messageBundlesRouter;
