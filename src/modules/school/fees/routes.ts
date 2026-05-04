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
  createFeeStructure,
  deleteFeeStructure,
  getDueFeesForEnrollment,
  getFeeReport,
  getFeesClassSectionBreakdown,
  getFeesCollectionTrend,
  getFeesDashboard,
  getFeeStructures,
  getParentChildFees,
  getPaymentsForEnrollment,
  getStudentLedger,
  getStudentOwnFees,
  getStudentsByClassSection,
  recordFeePayment,
  updateFeeStructure,
} from "./services";

const feesRouter = new Hono<SchoolEnv>();

feesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Fee Structure CRUD ====================
const feeStructureSchema = z.object({
  academicYearId: z.number(),
  classSectionId: z.number(),
  feeType: z.string().min(3), // "TUITION"
  amount: z.number().positive(),
  dueDate: z.string().date().optional(),
  isMandatory: z.boolean().default(true),
  description: z.string().optional(),
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
      console.error("Fee structure creation error:", error);
      return c.json({ error: error.message }, 400);
    }
  }
);

feesRouter.get("/structures", requirePermission("fees.report"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const structures = await getFeeStructures(c.env, schoolCode);
    console.log("Fetched fee structures:", structures);

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

// ==================== Record Fee Payment ====================
const paymentSchema = z
  .object({
    enrollmentId: z.number(),
    paymentMethod: z.enum(["CASH", "CHECK", "BANK_TRANSFER"]),
    notes: z.string().optional(),
    // Single fee payment (legacy / "Pay by Fee Type" mode)
    feeStructureId: z.number().optional(),
    amountPaid: z.number().positive().optional(),
    // Distributed payment ("Pay All" mode) — array of per-fee amounts
    payments: z
      .array(
        z.object({
          feeStructureId: z.number(),
          amountPaid: z.number().positive(),
        })
      )
      .optional(),
  })
  .refine(
    (d) =>
      // Must have either single-fee fields OR a payments array (not neither)
      (d.feeStructureId !== undefined && d.amountPaid !== undefined) ||
      (d.payments !== undefined && d.payments.length > 0),
    {
      message:
        "Provide either feeStructureId + amountPaid (single) or payments[] (distributed)",
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

// ==================== Get Student Ledger ====================
const ledgerSchema = z.object({
  studentId: z.coerce.number(), // Added coerce to handle string query params
  academicYearId: z.coerce.number().optional(), // Default to current
});

feesRouter.get(
  "/ledger",
  // Students/parents can view their own ledger; staff need fees.report
  // We allow fees.report OR fees.ledger.view (own) — handled in service layer
  requirePermission(["fees.report", "fees.ledger.view"]),
  zValidator("query", ledgerSchema),
  async (c) => {
    try {
      const { studentId, academicYearId } = c.req.valid("query");
      console.log(
        `Fetching ledger for studentId=${studentId}, academicYearId=${
          academicYearId || "current"
        }`
      ); // ← ADDED: Debug log
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

// ==================== Get Fee Report ====================
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

// ==================== Get Students by Class + Section (for Fee Payment Table) ====================
const studentsByClassSectionSchema = z.object({
  classSectionId: z.coerce.number(),
});

feesRouter.get(
  "/students-by-class-section",
  requirePermission("fees.payments.record"),
  zValidator("query", studentsByClassSectionSchema),
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

// ==================== Get Due Fees for Specific Enrollment ====================
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

// ==================== Get Payment History for Specific Enrollment ====================
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

// ==================== FEES DASHBOARD (Production Grade) ====================
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

// ==================== STUDENT: View Own Fees ====================
// Route: GET /school/fees/student/my-fees
// Guard: fees.student.view  (student-category permission)
// The student's userId is read from the validated JWT — no impersonation possible.
// Optional ?academicYearId=N filters to a specific year; omit for all years.

const studentFeesQuerySchema = z.object({
  academicYearId: z.coerce.number().optional(),
});

feesRouter.get(
  "/student/my-fees",
  requirePermission("fees.student.view"),
  zValidator("query", studentFeesQuerySchema),
  async (c) => {
    try {
      const user = c.get("user")!; // from validated JWT
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

// ==================== PARENT: View Child's Fees ====================
// Route: GET /school/fees/parent/child-fees
// Guard: fees.parent.view  (parent-category permission)
// X-Active-Child-Id header is injected by auth-interceptor.ts for STUDENT_PARENT role.
// The parent-child link is verified server-side via the student_parents table.
// Optional ?academicYearId=N filters to a specific year; omit for all years.

const parentFeesQuerySchema = z.object({
  academicYearId: z.coerce.number().optional(),
});

feesRouter.get(
  "/parent/child-fees",
  requirePermission("fees.parent.view"),
  zValidator("query", parentFeesQuerySchema),
  async (c) => {
    try {
      const user = c.get("user")!; // parent's userId from JWT
      const schoolCode = c.get("schoolCode")!;
      const { academicYearId } = c.req.valid("query");

      // X-Active-Child-Id is set by auth-interceptor.ts from ParentService.activeChildId()
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
      // 401-style error from getParentChildFees when relationship not found
      if (error.message?.includes("Unauthorized")) {
        return c.json({ success: false, error: error.message }, 403);
      }
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

export default feesRouter;
