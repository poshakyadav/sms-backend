// src/modules/school/contact/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SchoolEnv } from "../../../types/common-types";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { submitContactMessage, getSchoolContactHistory } from "./services";
import { getCommonDB } from "../../../db";
import { SCHOOL_PERMISSIONS } from "../../../types/school-permissions";

const schoolContactRouter = new Hono<SchoolEnv>();

// Both endpoints require school auth
schoolContactRouter.use(
  "/*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ── Submit a contact/support message ─────────────────────────────────────────
const submitSchema = z.object({
  category: z.enum([
    "TECHNICAL_ISSUE",
    "BILLING",
    "FEATURE_REQUEST",
    "ACCOUNT_ISSUE",
    "OTHER",
  ]),
  subject: z.string().min(5).max(120),
  message: z.string().min(20).max(2000),
  ownerPhone: z.string().max(15).optional(),
});

schoolContactRouter.post(
  "/submit",
  zValidator("json", submitSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolUser = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;

      // ✅ Permission check: only users with '*' (owner) or a dedicated permission
      const permissions: string[] = schoolUser.permissions ?? [];
      const canContact =
        permissions.includes("*") ||
        permissions.includes(SCHOOL_PERMISSIONS.CONTACT.SUBMIT);

      if (!canContact) {
        return c.json(
          {
            success: false,
            error: "You do not have permission to contact support.",
          },
          403
        );
      }

      const commonDb = getCommonDB(c.env);

      const result = await submitContactMessage(
        commonDb,
        {
          ...data,
          ownerUserId: schoolUser.id,
          ownerName: schoolUser.name ?? "",
          ownerEmail: schoolUser.email ?? "",
          ownerPhone: data.ownerPhone ?? "",
          schoolCode,
        },
        c.env
      );

      return c.json({
        success: true,
        message:
          "Your message has been received. We'll get back to you within 1–2 business days.",
        messageId: result.id,
        referenceId: `MSG-${String(result.id).padStart(6, "0")}`,
      });
    } catch (error: any) {
      console.error("Contact submit error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to send message" },
        500
      );
    }
  }
);

// ── Get contact history for own school ───────────────────────────────────────
schoolContactRouter.get("/my", async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const commonDb = getCommonDB(c.env);

    const messages = await getSchoolContactHistory(commonDb, schoolCode);

    return c.json({ success: true, messages });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default schoolContactRouter;
