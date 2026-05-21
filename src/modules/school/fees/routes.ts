// …/school/fees/routes.ts  (PRODUCTION-GRADE — FULL REWRITE)
//
// New endpoints added in this version:
//
//  CONCESSIONS
//    POST  /fees/concessions                        — grant concession to a student
//    GET   /fees/concessions/:enrollmentId          — list all concessions for an enrollment
//    PATCH /fees/concessions/:id/revoke             — revoke a concession
//    GET   /fees/concessions/dashboard              — admin concession overview
//
//  STUDENT FEE ASSIGNMENTS (transport / hostel / custom)
//    POST  /fees/assignments                        — assign custom fee to a student
//    POST  /fees/assignments/bulk-monthly           — bulk assign monthly fees (transport/hostel)
//    GET   /fees/assignments/:enrollmentId          — list assignments for an enrollment
//    PATCH /fees/assignments/:id/cancel             — cancel an assignment
//
//  BULK MONTHLY FEE STRUCTURES (class-section level)
//    POST  /fees/structures/bulk-monthly            — create 12 monthly fee structures at once
//
//  EXISTING (updated to be concession + assignment aware)
//    All existing endpoints remain at the same URLs — backward compatible.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  cancelStudentFeeAssignment,
  createBulkMonthlyAssignments,
  createBulkMonthlyFeeStructures,
  createConcession,
  createFeeStructure,
  createStudentFeeAssignment,
  deleteFeeStructure,
  getConcessionDashboard,
  getConcessionsForStudent,
  getDueFeesForEnrollment,
  getFeeReport,
  getFeesClassSectionBreakdown,
  getFeesCollectionTrend,
  getFeesDashboard,
  getFeeStructures,
  getParentChildFees,
  getPaymentsForEnrollment,
  getStudentFeeAssignments,
  getStudentLedger,
  getStudentOwnFees,
  getStudentsByClassSection,
  recordFeePayment,
  revokeConcession,
  updateFeeStructure,
  voidFeePayment,
} from "./services";

const feesRouter = new Hono<SchoolEnv>();

feesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// FEE STRUCTURES CRUD
// ─────────────────────────────────────────────────────────────────────────────

const feeStructureSchema = z.object({
  academicYearId: z.number(),
  classSectionId: z.number(),
  feeType: z.string().min(2),
  amount: z.number().positive(),
  feeMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "feeMonth must be YYYY-MM")
    .optional()
    .nullable(),
  dueDate: z.string().date().optional().nullable(),
  isMandatory: z.boolean().default(true),
  description: z.string().optional().nullable(),
});

feesRouter.post(
  "/structures",
  requirePermission("fees.structures.manage"),
  zValidator("json", feeStructureSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createFeeStructure(c.env, schoolCode, data);
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * POST /fees/structures/bulk-monthly
 * Creates one fee structure per month between startMonth and endMonth.
 * Used for tuition fees that repeat monthly (same amount, same class-section).
 *
 * Body:
 *   academicYearId: number
 *   classSectionId: number
 *   feeType: string         — e.g. "TUITION"
 *   amount: number          — in paise, same for all months
 *   startMonth: string      — "YYYY-MM" e.g. "2025-04"
 *   endMonth: string        — "YYYY-MM" e.g. "2026-03"
 *   dueDayOfMonth?: number  — e.g. 10 → due on 10th of each month
 *   description?: string
 *   isMandatory?: boolean
 */
const bulkMonthlyStructureSchema = z.object({
  academicYearId: z.number(),
  classSectionId: z.number(),
  feeType: z.string().min(2),
  amount: z.number().positive(),
  startMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "startMonth must be YYYY-MM"),
  endMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "endMonth must be YYYY-MM"),
  dueDayOfMonth: z.number().int().min(1).max(28).optional(),
  description: z.string().optional().nullable(),
  isMandatory: z.boolean().default(true),
});

feesRouter.post(
  "/structures/bulk-monthly",
  requirePermission("fees.structures.manage"),
  zValidator("json", bulkMonthlyStructureSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await createBulkMonthlyFeeStructures(
        c.env,
        schoolCode,
        data
      );
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

feesRouter.get("/structures", requirePermission("fees.report"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const structures = await getFeeStructures(c.env, schoolCode);
    return c.json({ structures });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

feesRouter.put(
  "/structures/:id",
  requirePermission("fees.structures.manage"),
  zValidator("json", feeStructureSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateFeeStructure(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

feesRouter.delete(
  "/structures/:id",
  requirePermission("fees.structures.manage"),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;
      const result = await deleteFeeStructure(c.env, schoolCode, id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// FEE CONCESSIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /fees/concessions
 * Grant a per-student discount on a specific fee structure.
 *
 * Body:
 *   enrollmentId:    number
 *   feeStructureId:  number
 *   concessionType:  "PERCENTAGE" | "FIXED"
 *   concessionValue: number  — % (1-100) for PERCENTAGE, paise for FIXED
 *   reason:          string  — mandatory (audit trail)
 *
 * Guard: fees.structures.manage
 */
const createConcessionSchema = z.object({
  enrollmentId: z.number().int().positive(),
  feeStructureId: z.number().int().positive(),
  concessionType: z.enum(["PERCENTAGE", "FIXED"]),
  concessionValue: z.number().positive(),
  reason: z.string().min(5, "Reason must be at least 5 characters"),
});

feesRouter.post(
  "/concessions",
  requirePermission("fees.structures.manage"),
  zValidator("json", createConcessionSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await createConcession(c.env, schoolCode, {
        ...data,
        approvedBy: user.id,
      });
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * GET /fees/concessions/dashboard
 * Admin-level view: all concessions granted, with student names, amounts, reasons.
 * Used by the Concession Report tab in the fees dashboard.
 * Guard: fees.report
 */
const concessionDashboardSchema = z.object({
  academicYearId: z.coerce.number().optional(),
  classSectionId: z.coerce.number().optional(),
});

feesRouter.get(
  "/concessions/dashboard",
  requirePermission("fees.report"),
  zValidator("query", concessionDashboardSchema),
  async (c) => {
    try {
      const { academicYearId, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const result = await getConcessionDashboard(
        c.env,
        schoolCode,
        academicYearId,
        classSectionId
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

/**
 * GET /fees/concessions/:enrollmentId
 * List all concessions (active + historical) for a student enrollment.
 * Guard: fees.report OR fees.ledger.view
 */
feesRouter.get(
  "/concessions/:enrollmentId",
  requirePermission(["fees.report", "fees.ledger.view"]),
  async (c) => {
    try {
      const enrollmentId = parseInt(c.req.param("enrollmentId"));
      const schoolCode = c.get("schoolCode")!;
      const concessions = await getConcessionsForStudent(
        c.env,
        schoolCode,
        enrollmentId
      );
      return c.json({ concessions });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * PATCH /fees/concessions/:id/revoke
 * Revoke (soft-delete) an active concession.
 * The concession record is preserved for audit; isActive is set to false.
 * Guard: fees.structures.manage
 */
feesRouter.patch(
  "/concessions/:id/revoke",
  requirePermission("fees.structures.manage"),
  async (c) => {
    try {
      const concessionId = parseInt(c.req.param("id"));
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await revokeConcession(
        c.env,
        schoolCode,
        concessionId,
        user.id
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT FEE ASSIGNMENTS (transport / hostel / custom per-student fees)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /fees/assignments
 * Assign a custom fee (transport zone, hostel room, sports, etc.) to a specific student.
 *
 * Body:
 *   enrollmentId:  number
 *   academicYearId: number
 *   feeType:       string    — "TRANSPORT" | "HOSTEL" | "SPORTS" | any custom
 *   amount:        number    — in paise (fully custom per student)
 *   feeMonth?:     string    — "YYYY-MM" for monthly fees (null for one-time)
 *   dueDate?:      string    — "YYYY-MM-DD"
 *   description?:  string    — e.g. "Zone 3 - Kidwai Nagar route"
 *   isMandatory?:  boolean
 *
 * Guard: fees.structures.manage
 */
const createAssignmentSchema = z.object({
  enrollmentId: z.number().int().positive(),
  academicYearId: z.number().int().positive(),
  feeType: z.string().min(2),
  amount: z.number().positive(),
  feeMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "feeMonth must be YYYY-MM")
    .optional()
    .nullable(),
  dueDate: z.string().date().optional().nullable(),
  description: z.string().optional().nullable(),
  isMandatory: z.boolean().default(true),
});

feesRouter.post(
  "/assignments",
  requirePermission("fees.structures.manage"),
  zValidator("json", createAssignmentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await createStudentFeeAssignment(c.env, schoolCode, {
        ...data,
        assignedBy: user.id,
      });
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * POST /fees/assignments/bulk-monthly
 * Creates monthly fee assignments for a student for a date range.
 * Perfect for transport or hostel fees — one call creates all 12 months.
 *
 * Body:
 *   enrollmentId:    number
 *   academicYearId:  number
 *   feeType:         string    — "TRANSPORT" | "HOSTEL" | etc.
 *   amount:          number    — in paise (same for all months)
 *   startMonth:      string    — "YYYY-MM" e.g. "2025-04"
 *   endMonth:        string    — "YYYY-MM" e.g. "2026-03"
 *   dueDayOfMonth?:  number    — e.g. 10 → due on 10th of each month
 *   description?:    string
 *
 * Guard: fees.structures.manage
 */
const bulkMonthlyAssignmentSchema = z.object({
  enrollmentId: z.number().int().positive(),
  academicYearId: z.number().int().positive(),
  feeType: z.string().min(2),
  amount: z.number().positive(),
  startMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "startMonth must be YYYY-MM"),
  endMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "endMonth must be YYYY-MM"),
  dueDayOfMonth: z.number().int().min(1).max(28).optional(),
  description: z.string().optional().nullable(),
});

feesRouter.post(
  "/assignments/bulk-monthly",
  requirePermission("fees.structures.manage"),
  zValidator("json", bulkMonthlyAssignmentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await createBulkMonthlyAssignments(c.env, schoolCode, {
        ...data,
        assignedBy: user.id,
      });
      return c.json(result, 201);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * GET /fees/assignments/:enrollmentId
 * List all custom fee assignments for a student.
 * ?includeAll=true shows cancelled assignments too (for history/audit).
 * Guard: fees.report OR fees.payments.record
 */
feesRouter.get(
  "/assignments/:enrollmentId",
  requirePermission([
    "fees.report",
    "fees.payments.record",
    "fees.ledger.view",
  ]),
  async (c) => {
    try {
      const enrollmentId = parseInt(c.req.param("enrollmentId"));
      const includeAll = c.req.query("includeAll") === "true";
      const schoolCode = c.get("schoolCode")!;
      const assignments = await getStudentFeeAssignments(
        c.env,
        schoolCode,
        enrollmentId,
        !includeAll
      );
      return c.json({ assignments });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

/**
 * PATCH /fees/assignments/:id/cancel
 * Cancel a student fee assignment (e.g. student stopped using transport).
 * Soft-delete: record is preserved for audit, payments history remains.
 *
 * Body: { reason: string }
 * Guard: fees.structures.manage
 */
const cancelAssignmentSchema = z.object({
  reason: z
    .string()
    .min(5, "Cancellation reason must be at least 5 characters"),
});

feesRouter.patch(
  "/assignments/:id/cancel",
  requirePermission("fees.structures.manage"),
  zValidator("json", cancelAssignmentSchema),
  async (c) => {
    try {
      const assignmentId = parseInt(c.req.param("id"));
      const { reason } = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await cancelStudentFeeAssignment(
        c.env,
        schoolCode,
        assignmentId,
        user.id,
        reason
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// RECORD FEE PAYMENT (updated — supports feeStructureId + studentFeeAssignmentId)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /fees/payments
 *
 * Supports three modes:
 *
 * 1. Single fee structure payment (legacy, backward compat):
 *    { enrollmentId, paymentMethod, feeStructureId, amountPaid }
 *
 * 2. Single student fee assignment payment (new — transport/hostel):
 *    { enrollmentId, paymentMethod, studentFeeAssignmentId, amountPaid }
 *
 * 3. Distributed multi-fee payment (new — pay multiple fees at once):
 *    { enrollmentId, paymentMethod, payments: [
 *        { feeStructureId: 1, amountPaid: 50000 },
 *        { studentFeeAssignmentId: 3, amountPaid: 80000 },
 *      ]
 *    }
 *
 * Amounts are in paise (₹1 = 100 paise).
 * Guard: fees.payments.record
 */
const paymentItemSchema = z.object({
  feeStructureId: z.number().int().positive().optional(),
  studentFeeAssignmentId: z.number().int().positive().optional(),
  amountPaid: z.number().positive(),
});

const paymentSchema = z
  .object({
    enrollmentId: z.number(),
    paymentMethod: z.enum(["CASH", "CHECK", "BANK_TRANSFER"]),
    notes: z.string().optional(),
    // Mode 1 or 2: single payment
    feeStructureId: z.number().optional(),
    studentFeeAssignmentId: z.number().optional(),
    amountPaid: z.number().positive().optional(),
    // Mode 3: multi-payment array
    payments: z.array(paymentItemSchema).optional(),
  })
  .refine(
    (d) =>
      (d.feeStructureId !== undefined && d.amountPaid !== undefined) ||
      (d.studentFeeAssignmentId !== undefined && d.amountPaid !== undefined) ||
      (d.payments !== undefined && d.payments.length > 0),
    {
      message:
        "Provide feeStructureId+amountPaid, studentFeeAssignmentId+amountPaid, or a payments[] array",
    }
  );

feesRouter.post(
  "/payments",
  requirePermission("fees.payments.record"),
  zValidator("json", paymentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await recordFeePayment(c.env, schoolCode, data, user.id);
      return c.json(result, 201);
    } catch (error: any) {
      console.error("Fee payment error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Using this accountant has way to void an incorrect payment
// ─────────────────────────────────────────────────────────────────────────────
const voidPaymentSchema = z.object({
  reason: z.string().min(5),
});

feesRouter.patch(
  "/payments/:id/void",
  requirePermission("fees.payments.record"),
  zValidator("json", voidPaymentSchema),
  async (c) => {
    try {
      const paymentId = parseInt(c.req.param("id"));
      const { reason } = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await voidFeePayment(c.env, schoolCode, paymentId, user.id, reason);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT LEDGER
// ─────────────────────────────────────────────────────────────────────────────

const ledgerSchema = z.object({
  studentId: z.coerce.number(),
  academicYearId: z.coerce.number().optional(),
});

feesRouter.get(
  "/ledger",
  requirePermission(["fees.report", "fees.ledger.view"]),
  zValidator("query", ledgerSchema),
  async (c) => {
    try {
      const { studentId, academicYearId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const ledger = await getStudentLedger(
        c.env,
        schoolCode,
        studentId,
        academicYearId
      );
      return c.json({ ledger });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// FEE REPORT
// ─────────────────────────────────────────────────────────────────────────────

const reportSchema = z.object({
  classSectionId: z.coerce.number({
    message: "classSectionId is required and must be a number",
  }),
  academicYearId: z.coerce.number().optional(),
  overdueOnly: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

feesRouter.get(
  "/report",
  requirePermission("fees.report"),
  zValidator("query", reportSchema),
  async (c) => {
    try {
      const { classSectionId, academicYearId, overdueOnly } =
        c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const report = await getFeeReport(c.env, schoolCode, {
        classSectionId,
        academicYearId,
        overdueOnly,
      });
      return c.json({ report });
    } catch (error: any) {
      console.error("Fee report error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENTS BY CLASS-SECTION (for payment table)
// ─────────────────────────────────────────────────────────────────────────────

feesRouter.get(
  "/students-by-class-section",
  requirePermission("fees.payments.record"),
  zValidator("query", z.object({ classSectionId: z.coerce.number() })),
  async (c) => {
    try {
      const { classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const students = await getStudentsByClassSection(
        c.env,
        schoolCode,
        classSectionId
      );
      return c.json({ students });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DUE FEES FOR ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

feesRouter.get(
  "/due-fees/:enrollmentId",
  requirePermission(["fees.payments.record", "fees.ledger.view"]),
  async (c) => {
    try {
      const enrollmentId = parseInt(c.req.param("enrollmentId"));
      const schoolCode = c.get("schoolCode")!;
      const dueFees = await getDueFeesForEnrollment(
        c.env,
        schoolCode,
        enrollmentId
      );
      return c.json(dueFees);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT HISTORY FOR ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

feesRouter.get(
  "/payments-history/:enrollmentId",
  requirePermission(["fees.payments.record", "fees.ledger.view"]),
  async (c) => {
    try {
      const enrollmentId = parseInt(c.req.param("enrollmentId"));
      const schoolCode = c.get("schoolCode")!;
      const history = await getPaymentsForEnrollment(
        c.env,
        schoolCode,
        enrollmentId
      );
      return c.json({ history });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// FEES DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

const dashboardSchema = z.object({
  academicYearId: z.coerce.number().optional(),
  classSectionId: z.coerce.number().optional(),
});

feesRouter.get(
  "/dashboard",
  requirePermission("fees.report"),
  zValidator("query", dashboardSchema),
  async (c) => {
    try {
      const { academicYearId, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const dashboard = await getFeesDashboard(
        c.env,
        schoolCode,
        academicYearId,
        classSectionId
      );
      return c.json({ dashboard });
    } catch (error: any) {
      console.error("Dashboard error:", error);
      return c.json({ error: error.message }, 500);
    }
  }
);

feesRouter.get(
  "/dashboard/trend",
  requirePermission("fees.report"),
  zValidator("query", dashboardSchema),
  async (c) => {
    try {
      const { academicYearId, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const trend = await getFeesCollectionTrend(
        c.env,
        schoolCode,
        academicYearId,
        classSectionId
      );
      return c.json({ trend });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

feesRouter.get(
  "/dashboard/breakdown",
  requirePermission("fees.report"),
  zValidator("query", dashboardSchema),
  async (c) => {
    try {
      const { academicYearId, classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const breakdown = await getFeesClassSectionBreakdown(
        c.env,
        schoolCode,
        academicYearId,
        classSectionId
      );
      return c.json({ breakdown });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT PORTAL: View Own Fees (month-wise + concession-aware)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /fees/student/my-fees
 * Student views their own fees.
 * Returns concession-aware breakdown grouped by academic year.
 * Each fee item includes: feeMonth, originalAmount, concessionAmount, effectiveAmount, status.
 * Guard: fees.student.view
 */
feesRouter.get(
  "/student/my-fees",
  requirePermission("fees.student.view"),
  zValidator(
    "query",
    z.object({ academicYearId: z.coerce.number().optional() })
  ),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const { academicYearId } = c.req.valid("query");
      const overview = await getStudentOwnFees(
        c.env,
        schoolCode,
        user.id,
        academicYearId
      );
      return c.json({ success: true, overview });
    } catch (error: any) {
      console.error("Student fees error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PARENT PORTAL: View Child's Fees (month-wise + concession-aware + assignments)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /fees/parent/child-fees
 * Parent views their selected child's fees.
 * X-Active-Child-Id header is required (set by auth-interceptor.ts).
 * Returns concession-aware breakdown + custom assignments (transport/hostel).
 * Guard: fees.parent.view
 */
feesRouter.get(
  "/parent/child-fees",
  requirePermission("fees.parent.view"),
  zValidator(
    "query",
    z.object({ academicYearId: z.coerce.number().optional() })
  ),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const { academicYearId } = c.req.valid("query");

      const activeChildHeader = c.req.header("X-Active-Child-Id");
      if (!activeChildHeader) {
        return c.json(
          {
            success: false,
            error: "No active child selected. Please select a child first.",
          },
          400
        );
      }

      const childStudentId = parseInt(activeChildHeader, 10);
      if (isNaN(childStudentId)) {
        return c.json({ success: false, error: "Invalid child ID" }, 400);
      }

      const overview = await getParentChildFees(
        c.env,
        schoolCode,
        user.id,
        childStudentId,
        academicYearId
      );

      return c.json({ success: true, overview });
    } catch (error: any) {
      console.error("Parent child fees error:", error);
      if (error.message?.includes("Unauthorized")) {
        return c.json({ success: false, error: error.message }, 403);
      }
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

export default feesRouter;
