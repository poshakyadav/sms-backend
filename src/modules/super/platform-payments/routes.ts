// src/modules/super/platform-payments/routes.ts

import { Hono } from "hono";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import {
  platformPaymentsSchema,
  schoolsSchema,
  schoolAccessPeriodsSchema,
} from "../../../db/schemas/super";
import { getRazorpayService } from "../../../services/razorpay/razorpay-service";

const platformPaymentsRouter = new Hono<Env>();

platformPaymentsRouter.use("*", jwtMiddleware, superTokenValidationMiddleware);

// ==================== LIST ALL PAYMENTS ====================
// GET /super/platform-payments?schoolId=&paymentType=&status=&limit=50&offset=0
platformPaymentsRouter.get(
  "/",
  requireSuperPermission("platform-payments.view"),
  async (c) => {
    try {
      const db = getCommonDB(c.env);
      const schoolIdParam = c.req.query("schoolId");
      const paymentType = c.req.query("paymentType");
      const status = c.req.query("status");
      const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
      const offset = parseInt(c.req.query("offset") ?? "0", 10);

      // Build conditions upfront — before the query is constructed
      const conditions: any[] = [];
      if (schoolIdParam) {
        conditions.push(
          eq(platformPaymentsSchema.schoolId, parseInt(schoolIdParam, 10))
        );
      }
      if (paymentType) {
        conditions.push(
          eq(platformPaymentsSchema.paymentType, paymentType as any)
        );
      }
      if (status) {
        conditions.push(eq(platformPaymentsSchema.status, status as any));
      }

      const payments = await db
        .select({
          id: platformPaymentsSchema.id,
          schoolId: platformPaymentsSchema.schoolId,
          schoolName: schoolsSchema.name,
          schoolCode: schoolsSchema.uniqueCode,
          paymentType: platformPaymentsSchema.paymentType,
          source: platformPaymentsSchema.source,
          amountPaise: platformPaymentsSchema.amountPaise,
          currency: platformPaymentsSchema.currency,
          status: platformPaymentsSchema.status,
          method: platformPaymentsSchema.method,
          description: platformPaymentsSchema.description,
          razorpayOrderId: platformPaymentsSchema.razorpayOrderId,
          razorpayPaymentId: platformPaymentsSchema.razorpayPaymentId,
          capturedAt: platformPaymentsSchema.capturedAt,
          createdAt: platformPaymentsSchema.createdAt,
        })
        .from(platformPaymentsSchema)
        .leftJoin(
          schoolsSchema,
          eq(platformPaymentsSchema.schoolId, schoolsSchema.id)
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(platformPaymentsSchema.createdAt))
        .limit(limit)
        .offset(offset)
        .all();

      return c.json({ success: true, payments, limit, offset });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET PAYMENT DETAIL ====================
// GET /super/platform-payments/:id
platformPaymentsRouter.get(
  "/:id",
  requireSuperPermission("platform-payments.view"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (isNaN(id))
        return c.json({ success: false, error: "Invalid ID" }, 400);

      const db = getCommonDB(c.env);
      const payment = await db
        .select()
        .from(platformPaymentsSchema)
        .where(eq(platformPaymentsSchema.id, id))
        .get();

      if (!payment)
        return c.json({ success: false, error: "Payment not found" }, 404);
      return c.json({ success: true, payment });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET SCHOOL ACCESS OVERVIEW ====================
// GET /super/platform-payments/school/:schoolId/access
// Returns a school's full access period history and current status
platformPaymentsRouter.get(
  "/school/:schoolId/access",
  requireSuperPermission("school-access.view"),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("schoolId"), 10);
      if (isNaN(schoolId))
        return c.json({ success: false, error: "Invalid school ID" }, 400);

      const db = getCommonDB(c.env);
      const { getSchoolAccessStatus } = await import(
        "../../../utils/access-periods"
      );

      const [accessStatus, periods] = await Promise.all([
        getSchoolAccessStatus(db, schoolId),
        db
          .select()
          .from(schoolAccessPeriodsSchema)
          .where(eq(schoolAccessPeriodsSchema.schoolId, schoolId))
          .orderBy(desc(schoolAccessPeriodsSchema.createdAt))
          .all(),
      ]);

      return c.json({ success: true, ...accessStatus, periods });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== MANUAL ACCESS GRANT (OVERRIDE) ====================
// POST /super/platform-payments/school/:schoolId/grant-access
// Super admin can manually grant access (e.g., free trial, goodwill extension)
platformPaymentsRouter.post(
  "/school/:schoolId/grant-access",
  requireSuperPermission("school-access.override"),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("schoolId"), 10);
      if (isNaN(schoolId))
        return c.json({ success: false, error: "Invalid school ID" }, 400);

      const body = await c.req.json();
      const { planType, durationDays, notes } = body as {
        planType: "MONTHLY" | "YEARLY";
        durationDays: number;
        notes: string;
      };

      if (!planType || !durationDays || !notes) {
        return c.json(
          {
            success: false,
            error: "planType, durationDays, and notes are required",
          },
          400
        );
      }

      const db = getCommonDB(c.env);
      const { grantAccessPeriod } = await import(
        "../../../utils/access-periods"
      );

      const { expiresAt } = await grantAccessPeriod(db, {
        schoolId,
        planType,
        source: "MANUAL_ORDER",
        platformPaymentId: null,
        durationDays,
        notes: `[ADMIN OVERRIDE] ${notes}`,
      });

      // Ensure school.isActive = true
      await db
        .update(schoolsSchema)
        .set({ isActive: true, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(schoolsSchema.id, schoolId));

      return c.json({
        success: true,
        message: `Access granted for ${durationDays} days`,
        expiresAt,
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 400);
    }
  }
);

export default platformPaymentsRouter;
