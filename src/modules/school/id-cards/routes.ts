// src/modules/school/id-cards/routes.ts

import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  ALL_ID_CARD_HOLDER_TYPES,
  IdCardOrientation,
  IdCardStatus,
  IdCardStatusValue,
  idCardTemplatesSchema,
  schoolsSchema
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { requirePermission, schoolJwtMiddleware, schoolTokenValidationMiddleware } from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  deleteIdCard,
  deleteIdCardsBulk,
  generateIdCard,
  generateIdCardsBulk,
  getEligibleHolders,
  getIdCardData,
  listIdCards,
  reissueIdCard,
  revokeIdCard,
} from "./services";

const idCardsRouter = new Hono<SchoolEnv>();

idCardsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ── Auth/DB pattern note ────────────────────────────────────────────────────
// This router does NOT receive a `db` from context — your codebase never
// stores it there. Every handler below resolves its own connection exactly
// like school/auth/routes.ts does:
//
//   const schoolCode = c.get("schoolCode") || c.req.header("X-School-Code");
//   const db = await getSchoolDB(c.env, schoolCode);
//
// and reads the authenticated user from c.get("user") (set by
// schoolTokenValidationMiddleware), NOT c.get("userId") — that key doesn't
// exist. c.get("user").id is the school_users.id to use for issuedBy /
// revokedBy / etc.
//
// Permission gating uses the real requirePermission(slug) middleware from
// src/middleware/school-auth.ts, applied per-route below — not an inline
// placeholder comment.

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const layoutConfigSchema = z.object({
  accentColor: z.string(),
  accentTextColor: z.string(),
  backgroundColor: z.string(),
  showLogo: z.boolean(),
  showTagline: z.boolean(),
  visibleFields: z.array(z.string()),
  footerNote: z.string(),
  qrSizeRatio: z.number().min(0.1).max(0.4),
  orientation: z
    .enum([IdCardOrientation.HORIZONTAL, IdCardOrientation.VERTICAL])
    .optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(2),
  holderType: z.enum(ALL_ID_CARD_HOLDER_TYPES),
  layoutConfig: layoutConfigSchema,
  isDefault: z.boolean().optional(),
});

idCardsRouter.post(
  "/templates",
  requirePermission(["id-cards.templates.manage"]),
  zValidator("json", createTemplateSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode") as string;
      const db = await getSchoolDB(c.env, schoolCode);

      if (data.isDefault) {
        // Unset any existing default for this holderType before setting the
        // new one — mirrors the "only one active theme" pattern already
        // used for school_theme_configs.
        await db
          .update(idCardTemplatesSchema)
          .set({ isDefault: false })
          .where(eq(idCardTemplatesSchema.holderType, data.holderType));
      }

      const inserted = await db
        .insert(idCardTemplatesSchema)
        .values({
          name: data.name,
          holderType: data.holderType,
          layoutConfig: JSON.stringify(data.layoutConfig),
          isDefault: data.isDefault ?? false,
        })
        .returning()
        .get();

      return c.json({ success: true, template: inserted });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

idCardsRouter.get(
  "/templates",
  requirePermission([
    "id-cards.view",
    "id-cards.generate",
    "id-cards.templates.manage",
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode") as string;
      const db = await getSchoolDB(c.env, schoolCode);
      const holderType = c.req.query("holderType"); // optional filter

      const conditions = [eq(idCardTemplatesSchema.isActive, true)];
      if (holderType) {
        conditions.push(
          eq(idCardTemplatesSchema.holderType, holderType as any)
        );
      }

      const templates = await db
        .select()
        .from(idCardTemplatesSchema)
        .where(and(...conditions))
        .all();

      return c.json({
        success: true,
        templates: templates.map((t: any) => ({
          ...t,
          layoutConfig: JSON.parse(t.layoutConfig),
        })),
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

const updateTemplateSchema = createTemplateSchema.partial();

idCardsRouter.put(
  "/templates/:id",
  requirePermission("id-cards.templates.manage"),
  zValidator("json", updateTemplateSchema),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode") as string;
      const db = await getSchoolDB(c.env, schoolCode);

      if (data.isDefault && data.holderType) {
        await db
          .update(idCardTemplatesSchema)
          .set({ isDefault: false })
          .where(eq(idCardTemplatesSchema.holderType, data.holderType));
      }

      const updatePayload: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      if (data.name !== undefined) updatePayload.name = data.name;
      if (data.holderType !== undefined)
        updatePayload.holderType = data.holderType;
      if (data.layoutConfig !== undefined)
        updatePayload.layoutConfig = JSON.stringify(data.layoutConfig);
      if (data.isDefault !== undefined)
        updatePayload.isDefault = data.isDefault;

      await db
        .update(idCardTemplatesSchema)
        .set(updatePayload)
        .where(eq(idCardTemplatesSchema.id, id));

      return c.json({ success: true, message: "Template updated" });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

idCardsRouter.delete(
  "/templates/:id",
  requirePermission("id-cards.templates.manage"),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const schoolCode = c.get("schoolCode") as string;
      const db = await getSchoolDB(c.env, schoolCode);
      // Soft-delete only — never hard-delete a template that historical cards
      // reference (templateId FK uses onDelete: "set null" for exactly this
      // reason, but soft-deleting here avoids orphaning the FK at all).
      await db
        .update(idCardTemplatesSchema)
        .set({ isActive: false })
        .where(eq(idCardTemplatesSchema.id, id));
      return c.json({ success: true, message: "Template deactivated" });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

const generateSingleSchema = z.object({
  holderUserId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  validUntil: z.string(), // ISO date
  enrollmentId: z.number().int().positive().optional(),
});

idCardsRouter.post(
  "/generate",
  requirePermission("id-cards.generate"),
  zValidator("json", generateSingleSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode") as string;
      const db = await getSchoolDB(c.env, schoolCode);
      const user = c.get("user")!;
      const school = await db
        .select({ shortName: schoolsSchema.shortName })
        .from(schoolsSchema)
        .get();

      const result = await generateIdCard(db, school?.shortName || "EDX", {
        ...data,
        issuedBy: user.id,
      });

      return c.json({ success: true, cardId: result.id });
    } catch (error: any) {
      if (error.code === "ACTIVE_CARD_EXISTS") {
        return c.json(
          {
            success: false,
            error: error.message,
            code: error.code,
            existingCardId: error.existingCardId,
          },
          409
        );
      }
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

const generateBulkSchema = z.object({
  templateId: z.number().int().positive(),
  validUntil: z.string(),
  // Each entry pairs a holder with their enrollment (students) — for staff,
  // enrollmentId is simply omitted per-entry.
  holders: z
    .array(
      z.object({
        holderUserId: z.number().int().positive(),
        enrollmentId: z.number().int().positive().optional(),
      })
    )
    .min(1)
    .max(500), // sane upper bound per request; frontend can chunk larger batches
});

idCardsRouter.post(
  "/generate/bulk",
  requirePermission("id-cards.generate"),
  zValidator("json", generateBulkSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);
      const issuedBy = c.get("user")!.id;

      const school = await db
        .select({ shortName: schoolsSchema.shortName })
        .from(schoolsSchema)
        .get();

      // NOTE: templateId and validUntil now passed once (shared across the
      // whole batch) instead of duplicated into every holder input.
      const result = await generateIdCardsBulk(db, school?.shortName || "EDX", {
        templateId: data.templateId,
        validUntil: data.validUntil,
        issuedBy,
        holders: data.holders,
      });

      return c.json({
        success: true,
        generatedCount: result.succeeded.length,
        failedCount: result.failed.length,
        cardIds: result.succeeded,
        failures: result.failed,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// LIST / FILTER
// ─────────────────────────────────────────────────────────────────────────────

idCardsRouter.get("/", requirePermission("id-cards.view"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);

    const holderTypeParam = c.req.query("holderType");
    const holderType =
      holderTypeParam === "STUDENT" || holderTypeParam === "STAFF"
        ? holderTypeParam
        : undefined;

    const statusParam = c.req.query("status");
    const status =
      statusParam && Object.values(IdCardStatus).includes(statusParam as any)
        ? (statusParam as IdCardStatusValue)
        : undefined;

    const classSectionIdParam = c.req.query("classSectionId");
    let classSectionId: number | undefined;
    if (classSectionIdParam && holderType === "STUDENT") {
      classSectionId = Number(classSectionIdParam);
      if (Number.isNaN(classSectionId)) {
        return c.json({ success: false, error: "Invalid classSectionId" }, 400);
      }
    }

    const cards = await listIdCards(db, { holderType, status, classSectionId });
    // console.log(`Listed ${cards.length} ID cards for school ${schoolCode}`);
    // console.log("Cards:", cards);
    return c.json({ success: true, cards });
  } catch (err: any) {
    console.error("Failed to list ID cards:", err);
    return c.json(
      { success: false, error: err.message || "Failed to fetch ID cards" },
      500
    );
  }
});

idCardsRouter.get("/eligible-holders", requirePermission("id-cards.view"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const db = await getSchoolDB(c.env, schoolCode);

    const holderTypeParam = c.req.query("holderType");
    if (holderTypeParam !== "STUDENT" && holderTypeParam !== "STAFF") {
      return c.json({ success: false, error: "holderType must be STUDENT or STAFF" }, 400);
    }

    let classSectionId: number | undefined;
    if (holderTypeParam === "STUDENT") {
      const raw = c.req.query("classSectionId");
      classSectionId = raw ? Number(raw) : undefined;
      if (!classSectionId || Number.isNaN(classSectionId)) {
        return c.json(
          { success: false, error: "classSectionId is required for STUDENT" },
          400
        );
      }
    }

    const holders = await getEligibleHolders(db, {
      holderType: holderTypeParam,
      classSectionId,
    });
    return c.json({ success: true, holders });
  } catch (err: any) {
    console.error("Failed to fetch eligible holders:", err);
    return c.json(
      { success: false, error: err.message || "Failed to fetch eligible holders" },
      500
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CARD DATA — single + bulk fetch, for rendering/printing on the frontend
// ─────────────────────────────────────────────────────────────────────────────

idCardsRouter.get(
  "/:id/data",
  requirePermission(["id-cards.view", "id-cards.print"]),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const school = await db
        .select({
          name: schoolsSchema.name,
          shortName: schoolsSchema.shortName,
          logoUrl: schoolsSchema.logoUrl,
          tagline: schoolsSchema.tagline,
          addressLineOne: schoolsSchema.addressLineOne,
          addressLineTwo: schoolsSchema.addressLineTwo,
          phone: schoolsSchema.phone,
        })
        .from(schoolsSchema)
        .get();

      if (!school)
        return c.json({ success: false, error: "School not found" }, 404);

      const schoolInfo = {
        ...school,
        addressLineTwo: school.addressLineTwo ?? "",
      };

      const frontendBaseUrl = c.env.FRONTEND_ORIGIN || "http://localhost:4200";
      const [card] = await getIdCardData(
        db,
        [id],
        schoolInfo,
        frontendBaseUrl,
        schoolCode
      );

      console.log(`Fetched ID card data for card ID ${id} in school ${schoolCode}`);
      console.log("Card data:", card);

      if (!card)
        return c.json({ success: false, error: "Card not found" }, 404);

      return c.json({ success: true, card });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

const bulkDataSchema = z.object({
  cardIds: z.array(z.number().int().positive()).min(1).max(200),
});

idCardsRouter.post(
  "/data/bulk",
  requirePermission(["id-cards.view", "id-cards.print"]),
  zValidator("json", bulkDataSchema),
  async (c) => {
    try {
      const { cardIds } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const school = await db
        .select({
          name: schoolsSchema.name,
          shortName: schoolsSchema.shortName,
          logoUrl: schoolsSchema.logoUrl,
          tagline: schoolsSchema.tagline,
          addressLineOne: schoolsSchema.addressLineOne,
          addressLineTwo: schoolsSchema.addressLineTwo,
          phone: schoolsSchema.phone,
        })
        .from(schoolsSchema)
        .get();

      if (!school)
        return c.json({ success: false, error: "School not found" }, 500);

      const schoolInfo = {
        ...school,
        addressLineTwo: school.addressLineTwo ?? "",
      };

      const frontendBaseUrl = c.env.FRONTEND_ORIGIN || "http://localhost:4200";
      const cards = await getIdCardData(
        db,
        cardIds,
        schoolInfo,
        frontendBaseUrl,
        schoolCode
      );

      return c.json({ success: true, cards });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// REVOKE / REISSUE
// ─────────────────────────────────────────────────────────────────────────────

const revokeSchema = z.object({ reason: z.string().min(3) });

idCardsRouter.post(
  "/:id/revoke",
  requirePermission("id-cards.revoke"),
  zValidator("json", revokeSchema),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const { reason } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);
      const revokedBy = c.get("user")!.id;

      await revokeIdCard(db, id, revokedBy, reason);
      return c.json({ success: true, message: "Card revoked" });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

const reissueSchema = z.object({
  templateId: z.number().int().positive().optional(),
  validUntil: z.string().optional(),
});

idCardsRouter.post(
  "/:id/reissue",
  requirePermission("id-cards.revoke"),
  zValidator("json", reissueSchema),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      const overrides = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);
      const issuedBy = c.get("user")!.id;

      const school = await db
        .select({ shortName: schoolsSchema.shortName })
        .from(schoolsSchema)
        .get();

      const result = await reissueIdCard(
        db,
        school?.shortName || "EDX",
        id,
        issuedBy,
        overrides
      );
      return c.json({ success: true, newCardId: result.id });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — permanent removal (distinct from /:id/revoke, which soft-revokes).
// Required before a holder who already has an active card can be issued a
// fresh one — see the ACTIVE_CARD_EXISTS guard inside generateIdCard().
//
// NOTE: uses the "id-cards.delete" permission slug. Add it to
// SchoolPermissionSlug (src/types/school-permissions.ts) and seed it into
// the permissions table with module "ID_CARDS", same as the other
// id-cards.* slugs — school-owner roles already get it automatically via
// the '*' wildcard.
// ─────────────────────────────────────────────────────────────────────────────

idCardsRouter.delete(
  "/:id",
  requirePermission("id-cards.delete"),
  async (c) => {
    try {
      const id = Number(c.req.param("id"));
      if (Number.isNaN(id)) {
        return c.json({ success: false, error: "Invalid card id" }, 400);
      }
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      await deleteIdCard(db, id);
      return c.json({ success: true, message: "Card deleted" });
    } catch (error: any) {
      const status = error.message === "Card not found" ? 404 : 400;
      return c.json({ success: false, error: error.message }, status);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — BULK (POST, not DELETE — mirrors /data/bulk's convention of using
// POST for any bulk operation that needs a JSON array body). Powers the
// "Delete Selected" action in id-card-management's table toolbar.
// ─────────────────────────────────────────────────────────────────────────────

const bulkDeleteSchema = z.object({
  cardIds: z.array(z.number().int().positive()).min(1).max(500),
});

idCardsRouter.post(
  "/delete/bulk",
  requirePermission("id-cards.delete"),
  zValidator("json", bulkDeleteSchema),
  async (c) => {
    try {
      const { cardIds } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const db = await getSchoolDB(c.env, schoolCode);

      const result = await deleteIdCardsBulk(db, cardIds);

      return c.json({
        success: true,
        deletedCount: result.deletedCount,
        deletedIds: result.deletedIds,
        notFound: result.notFound,
        message:
          result.notFound.length > 0
            ? `Deleted ${result.deletedCount} card(s). ${result.notFound.length} were already removed.`
            : `Deleted ${result.deletedCount} card(s).`,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

export default idCardsRouter;
