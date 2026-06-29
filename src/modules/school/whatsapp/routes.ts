// src/modules/school/whatsapp/routes.ts
// Canonical final version — deduped imports, all endpoints correct.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
  requirePermission,
} from "../../../middleware/school-auth";
import { requireActiveAccess } from "../../../middleware/require-active-access";
import { SchoolEnv } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { getSchoolDB } from "../../../db/school-client";
import { schoolsSchema } from "../../../db/schemas/super";
import { whatsappInboundMessagesSchema } from "../../../db/schemas/school";
import { whatsappBalanceSchema } from "../../../db/schemas/school/whatsapp-balance";
import { getWhatsappBalance } from "../../../utils/whatsapp-credits";
import { PLATFORM_TEMPLATES } from "../../../types/whatsapp";
import {
  syncTemplates,
  listTemplates,
  sendOneMessage,
  initiateBulkSend,
  executeBulkSend,
  getMessageHistory,
  getBulkSendStatus,
  getBulkSendList,
} from "./send-service";

const whatsappRouter = new Hono<SchoolEnv>();

// All routes: must be logged in AND have an active access subscription
whatsappRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
  requireActiveAccess
);

// ── Shared helper ─────────────────────────────────────────────────────────────
async function resolveSchoolName(c: any): Promise<string> {
  const schoolCode = c.get("schoolCode") as string;
  const db = getCommonDB(c.env);
  const school = await db
    .select({ name: schoolsSchema.name })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.uniqueCode, schoolCode))
    .get();
  return school?.name ?? "Your School";
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/whatsapp/templates
// Returns local cache + PLATFORM_TEMPLATES definitions (variable names, body preview)
whatsappRouter.get(
  "/templates",
  requirePermission("billing.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const onlyApproved = c.req.query("status") === "approved";
      const [templates] = await Promise.all([
        listTemplates(c.env, schoolCode, onlyApproved),
      ]);

      const definitions = (Object.entries(PLATFORM_TEMPLATES) as any[]).map(
        ([key, def]: any) => ({
          key,
          name: def.name,
          category: def.category,
          language: def.language,
          bodyText: def.bodyText,
          variables: def.variables,
          description: def.description,
        })
      );

      return c.json({ success: true, templates, definitions });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// POST /school/whatsapp/templates/sync
// Pulls latest template statuses from Meta WABA and updates local DB cache
whatsappRouter.post(
  "/templates/sync",
  requirePermission("billing.manage"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const result = await syncTemplates(c.env, schoolCode);
      return c.json({
        success: true,
        message: `Synced ${result.synced} templates (${result.approved} approved).`,
        ...result,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/whatsapp/balance
whatsappRouter.get("/balance", requirePermission("billing.view"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const schoolDb = await getSchoolDB(c.env, schoolCode);
    const balance = await getWhatsappBalance(schoolDb, whatsappBalanceSchema);
    return c.json({ success: true, balance });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SEND
// ─────────────────────────────────────────────────────────────────────────────

// POST /school/whatsapp/send
const sendSchema = z.object({
  templateKey: z.enum([
    "MONTHLY_FEE_DUE",
    "FEE_PAYMENT_CONFIRMED",
    "FEE_OVERDUE_ALERT",
    "STUDENT_FEE_ASSIGNED",
    "EXAM_SCHEDULE_PUBLISHED",
    "ADMIT_CARD_PUBLISHED",
    "RESULT_PUBLISHED",
    "STUDENT_ABSENT_TODAY",
    "LOW_ATTENDANCE_WARNING",
    "ADMISSION_CONFIRMED",
    "ASSIGNMENT_DUE_REMINDER",
    "GENERAL_NOTIFICATION",
    "HOLIDAY_NOTICE",
    "PTM_INVITE",
  ]),
  recipientPhone: z.string().min(7).max(20),
  recipientName: z.string().min(1).max(100),
  recipientType: z.enum(["PARENT", "STUDENT", "STAFF", "EXTERNAL"]),
  recipientUserId: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.string()),
  triggeredByModule: z.string().optional(),
  triggeredByEntityId: z.number().int().optional(),
});

whatsappRouter.post(
  "/send",
  requirePermission("billing.manage"),
  zValidator("json", sendSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await sendOneMessage(c.env, schoolCode, data as any);
      if (!result.success) {
        return c.json({ success: false, error: result.error }, 400);
      }
      return c.json(result);
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// BULK SEND
// ─────────────────────────────────────────────────────────────────────────────

// POST /school/whatsapp/bulk/initiate
// Validates, reserves credits, creates the bulk_send record, returns totals
const bulkInitiateSchema = z.object({
  title: z.string().min(3).max(200),
  templateKey: z.enum([
    "MONTHLY_FEE_DUE",
    "FEE_PAYMENT_CONFIRMED",
    "FEE_OVERDUE_ALERT",
    "STUDENT_FEE_ASSIGNED",
    "EXAM_SCHEDULE_PUBLISHED",
    "ADMIT_CARD_PUBLISHED",
    "RESULT_PUBLISHED",
    "STUDENT_ABSENT_TODAY",
    "LOW_ATTENDANCE_WARNING",
    "ADMISSION_CONFIRMED",
    "ASSIGNMENT_DUE_REMINDER",
    "GENERAL_NOTIFICATION",
    "HOLIDAY_NOTICE",
    "PTM_INVITE",
  ]),
  targetType: z.enum([
    "ALL_PARENTS",
    "ALL_STUDENTS",
    "ALL_STAFF",
    "CLASS_SECTION_PARENTS",
    "CLASS_SECTION_STUDENTS",
    "CUSTOM_USER_LIST",
    "CUSTOM_PHONE_LIST",
  ]),
  classSectionId: z.number().int().positive().optional(),
  userIds: z.array(z.number().int().positive()).max(500).optional(),
  phoneList: z.array(z.string()).max(500).optional(),
  variableResolver: z.literal("auto"),
});

whatsappRouter.post(
  "/bulk/initiate",
  requirePermission("billing.manage"),
  zValidator("json", bulkInitiateSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const user = c.get("user")!;
      const result = await initiateBulkSend(
        c.env,
        schoolCode,
        data as any,
        user.id
      );
      return c.json({ success: true, ...result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// POST /school/whatsapp/bulk/:id/start
// Begins dispatching all messages for the bulk send (async via waitUntil)
whatsappRouter.post(
  "/bulk/:id/start",
  requirePermission("billing.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid bulk send ID" }, 400);

      const schoolCode = c.get("schoolCode")!;
      const execPromise = executeBulkSend(c.env, schoolCode, id);

      // On Cloudflare Workers — return immediately, process in background
      if ((c as any).executionCtx?.waitUntil) {
        (c as any).executionCtx.waitUntil(
          execPromise.catch((e: any) =>
            console.error(`[WA] Bulk send ${id} error:`, e.message)
          )
        );
        return c.json({
          success: true,
          message: "Bulk send started. Poll /bulk/:id/status for progress.",
          bulkSendId: id,
        });
      }

      // Fallback: await result (local dev / non-Workers environments)
      const result = await execPromise;
      return c.json({ success: true, bulkSendId: id, ...result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

// GET /school/whatsapp/bulk/:id/status
whatsappRouter.get(
  "/bulk/:id/status",
  requirePermission("billing.view"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid ID" }, 400);
      const schoolCode = c.get("schoolCode")!;
      const bulkSend = await getBulkSendStatus(c.env, schoolCode, id);
      if (!bulkSend)
        return c.json({ success: false, error: "Bulk send not found" }, 404);
      return c.json({ success: true, bulkSend });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// GET /school/whatsapp/bulk
// List all bulk sends (most recent first)
whatsappRouter.get("/bulk", requirePermission("billing.view"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const bulkSends = await getBulkSendList(c.env, schoolCode, limit, offset);
    return c.json({ success: true, bulkSends });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HISTORY
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/whatsapp/messages?status=SENT&module=attendance&limit=20&offset=0
whatsappRouter.get(
  "/messages",
  requirePermission("billing.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;

      // ── NEW: parse + validate bulkSendId ──────────────────────────────────
      // Only pass it through when it's a genuine positive integer — an
      // invalid/garbage value (e.g. "abc") silently falls back to "no filter"
      // rather than returning a confusing 400 for a low-stakes list endpoint.
      const bulkSendIdRaw = c.req.query("bulkSendId");
      const bulkSendId =
        bulkSendIdRaw !== undefined ? parseInt(bulkSendIdRaw, 10) : undefined;

      const messages = await getMessageHistory(c.env, schoolCode, {
        limit: Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100),
        offset: parseInt(c.req.query("offset") ?? "0", 10),
        status: c.req.query("status"),
        module: c.req.query("module"),
        bulkSendId:
          bulkSendId !== undefined && !Number.isNaN(bulkSendId)
            ? bulkSendId
            : undefined,
      });
      return c.json({ success: true, messages });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/whatsapp/inbound?limit=20&offset=0
whatsappRouter.get("/inbound", requirePermission("billing.view"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const schoolDb = await getSchoolDB(c.env, schoolCode);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const messages = await schoolDb
      .select()
      .from(whatsappInboundMessagesSchema)
      .orderBy(desc(whatsappInboundMessagesSchema.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    return c.json({ success: true, messages });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SEND — verify the integration works end-to-end (1 credit consumed)
// ─────────────────────────────────────────────────────────────────────────────

// POST /school/whatsapp/test
// whatsappRouter.post(
//   "/test",
//   requirePermission("billing.manage"),
//   zValidator(
//     "json",
//     z.object({
//       phone: z.string().min(7).max(20),
//       name: z.string().min(1).max(100).optional(),
//     })
//   ),
//   async (c) => {
//     try {
//       const { phone, name = "Test User" } = c.req.valid("json");
//       const schoolCode = c.get("schoolCode")!;
//       const schoolName = await resolveSchoolName(c);

//       const result = await sendOneMessage(c.env, schoolCode, {
//         templateKey: "TEST_MESSAGE",
//         recipientPhone: phone,
//         recipientName: name,
//         recipientType: "EXTERNAL",
//         variables: { recipient_name: name, school_name: schoolName },
//         triggeredByModule: "manual",
//       });

//       return c.json(result);
//     } catch (error: any) {
//       return c.json({ success: false, error: error.message }, 400);
//     }
//   }
// );

export default whatsappRouter;
