// src/modules/public/school-registration-requests/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  getRegistrationRequestStatus,
  submitRegistrationRequest,
} from "./services";

const publicSchoolRequestsRouter = new Hono<Env>();

// ── Submit a new school registration request (public — no auth) ──────────────
const submitSchema = z.object({
  schoolName: z.string().min(3).max(100),
  ownerName: z.string().min(2).max(80),
  ownerEmail: z.string().email(),
  ownerPhone: z.string().min(10).max(15),
  city: z.string().min(2).max(60),
  state: z.string().min(2).max(60),
  schoolType: z.enum(["PRIMARY", "SECONDARY", "HIGHER_SECONDARY", "OTHER"]),
  estimatedStudents: z.number().int().min(1).max(50000).optional(),
  message: z.string().max(500).optional(),
});

publicSchoolRequestsRouter.post(
  "/",
  zValidator("json", submitSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const db = getCommonDB(c.env);

      const result = await submitRegistrationRequest(db, data, c.env);

      return c.json(
        {
          success: true,
          message:
            "Your registration request has been received. We will contact you within 24–48 hours.",
          requestId: result.id,
        },
        201
      );
    } catch (error: any) {
      // Duplicate request — friendly response, not an error
      if (error.message === "DUPLICATE_REQUEST") {
        return c.json(
          {
            success: false,
            duplicate: true,
            message:
              "We already have a registration request from this email address. Our team will contact you soon.",
          },
          409
        );
      }
      console.error("Registration request error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to submit request" },
        500
      );
    }
  }
);

// ── Check status by email (optional — lets school check if already submitted) ─
publicSchoolRequestsRouter.get("/status/:email", async (c) => {
  try {
    const email = c.req.param("email").toLowerCase().trim();
    const db = getCommonDB(c.env);

    const status = await getRegistrationRequestStatus(db, email);

    if (!status) {
      return c.json({ found: false });
    }

    return c.json({
      found: true,
      status: status.status,
      submittedAt: status.createdAt,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default publicSchoolRequestsRouter;
