// src/modules/school/about-us/routes.ts
// ─────────────────────────────────────────────────────────────────────────────
// About Us routes
//
//   GET  /school/about-us   → all authenticated school users
//   PUT  /school/about-us   → settings.manage permission only
//
// Registration in src/index.ts  (add these two lines):
//   import aboutUsRouter from "./modules/school/about-us/routes";
//   app.route("/school/about-us", aboutUsRouter);
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getAboutUs, upsertAboutUs } from "./services";

const aboutUsRouter = new Hono<SchoolEnv>();

// All routes require a valid school JWT
aboutUsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ══════════════════════════════════════════════════════════════════════════════
// GET /school/about-us
// Accessible to every authenticated school user (students, teachers, parents,
// staff, owner — everyone). Auto-seeds the singleton row if not yet created.
// ══════════════════════════════════════════════════════════════════════════════
aboutUsRouter.get("/", async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const aboutUs = await getAboutUs(c.env, schoolCode);
    return c.json({ success: true, aboutUs });
  } catch (error: any) {
    console.error("GET /school/about-us error:", error);
    return c.json(
      { success: false, error: error.message ?? "Internal error" },
      500
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /school/about-us
// Requires settings.manage permission. Accepts a partial payload — only the
// supplied keys are written to the DB. All fields are optional.
// ══════════════════════════════════════════════════════════════════════════════

// ── Sub-schemas ───────────────────────────────────────────────────────────────
const coreValueSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
});

const achievementSchema = z.object({
  year: z.number().int().min(1800).max(2100).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(500).default(""),
});

// ── Main update payload ───────────────────────────────────────────────────────
const updateAboutUsSchema = z.object({
  // Overview
  description: z.string().max(5000).optional(),
  mission: z.string().max(2000).optional(),
  vision: z.string().max(2000).optional(),

  // Identity
  foundedYear: z.number().int().min(1800).max(2100).nullable().optional(),
  foundedBy: z.string().max(200).optional(),
  history: z.string().max(10000).optional(),
  affiliationBoard: z.string().max(100).optional(),
  affiliationNumber: z.string().max(100).optional(),
  accreditation: z.string().max(200).optional(),

  // Stats
  totalStudents: z.number().int().min(0).nullable().optional(),
  totalTeachers: z.number().int().min(0).nullable().optional(),
  totalStaff: z.number().int().min(0).nullable().optional(),
  campusAreaAcres: z.string().max(20).optional(),

  // Principal
  principalName: z.string().max(200).optional(),
  principalMessage: z.string().max(3000).optional(),
  // URL or empty string — both valid
  principalAvatarUrl: z.union([z.string().url(), z.literal("")]).optional(),

  // Social — all URL-or-empty
  facebookUrl: z.union([z.string().url(), z.literal("")]).optional(),
  twitterUrl: z.union([z.string().url(), z.literal("")]).optional(),
  instagramUrl: z.union([z.string().url(), z.literal("")]).optional(),
  youtubeUrl: z.union([z.string().url(), z.literal("")]).optional(),
  linkedinUrl: z.union([z.string().url(), z.literal("")]).optional(),

  // Array fields
  facilities: z.array(z.string().min(1).max(100)).max(50).optional(),
  galleryUrls: z
    .array(z.union([z.string().url(), z.literal("")]))
    .max(20)
    .optional(),
  coreValues: z.array(coreValueSchema).max(10).optional(),
  achievements: z.array(achievementSchema).max(30).optional(),
});

aboutUsRouter.put(
  "/",
  requirePermission("settings.manage"),
  zValidator("json", updateAboutUsSchema),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const data = c.req.valid("json");

      // Strip empty gallery URLs before persisting (frontend may send "" for removed items)
      if (data.galleryUrls) {
        data.galleryUrls = data.galleryUrls.filter((u) => u.trim() !== "");
      }

      const aboutUs = await upsertAboutUs(c.env, schoolCode, data);
      return c.json({
        success: true,
        message: "About Us updated successfully",
        aboutUs,
      });
    } catch (error: any) {
      console.error("PUT /school/about-us error:", error);
      return c.json(
        { success: false, error: error.message ?? "Failed to update About Us" },
        500
      );
    }
  }
);

export default aboutUsRouter;
