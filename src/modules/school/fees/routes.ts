import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createFeeStructure,
  getFeeStructures,
  updateFeeStructure,
  deleteFeeStructure,
  recordFeePayment,
  getStudentLedger,
  getFeeReport,
  getStudentsByClassSection,
  getDueFeesForEnrollment,
  getPaymentsForEnrollment,
} from "./services";
import {
  schoolJwtMiddleware,
  schoolPermissionMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";

const feesRouter = new Hono<SchoolEnv>();

feesRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Fee Structure CRUD ====================
const feeStructureSchema = z.object({
  academicYearId: z.number(),
  classId: z.number(),
  classSectionId: z.number().nullable().optional(),   // ← NEW: classSectionId
  feeType: z.string().min(3), // "TUITION"
  amount: z.number().positive(),
  dueDate: z.string().date().optional(),
  isMandatory: z.boolean().default(true),
  description: z.string().optional(),
});

feesRouter.post(
  "/structures",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.ACCOUNTANT,
  ]),
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

feesRouter.get(
  "/structures",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ACCOUNTANT,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const structures = await getFeeStructures(c.env, schoolCode);
      console.log("Fetched fee structures:", structures);

      return c.json({ structures });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

feesRouter.put(
  "/structures/:id",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.ACCOUNTANT,
  ]),
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
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
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
const paymentSchema = z.object({
  enrollmentId: z.number(),
  feeStructureId: z.number(),
  amountPaid: z.number().positive(),
  paymentMethod: z.enum(["CASH", "CHECK", "BANK_TRANSFER"]),
  notes: z.string().optional(),
});

feesRouter.post(
  "/payments",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.ACCOUNTANT,
    SchoolRole.MANAGER,
  ]),
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
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ACCOUNTANT,
    SchoolRole.STUDENT_PARENT,
  ]),
  zValidator("query", ledgerSchema),
  async (c) => {
    try {
      const { studentId, academicYearId } = c.req.valid("query");
      console.log(`Fetching ledger for studentId=${studentId}, academicYearId=${academicYearId || 'current'}`); // ← ADDED: Debug log
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
// ****** Fix this get report by class-section-id
const reportSchema = z.object({
  classSectionId: z.number().optional(),
  overdueOnly: z.boolean().optional(),
});

feesRouter.get(
  "/report",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.ACCOUNTANT,
  ]),
  zValidator("query", reportSchema),
  async (c) => {
    try {
      const data = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const report = await getFeeReport(c.env, schoolCode, data);

      return c.json({ report });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Get Students by Class + Section (for Fee Payment Table) ====================
const studentsByClassSectionSchema = z.object({
  classSectionId: z.coerce.number(),   // ← CHANGED: single ID
});

feesRouter.get(
  "/students-by-class-section",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.ACCOUNTANT,
    SchoolRole.MANAGER,
  ]),
  zValidator("query", studentsByClassSectionSchema),
  async (c) => {
    try {
      const { classSectionId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const students = await getStudentsByClassSection(c.env, schoolCode, classSectionId);

      return c.json({ students });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Due Fees for Specific Enrollment ====================
feesRouter.get(
  "/due-fees/:enrollmentId",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.ACCOUNTANT,
    SchoolRole.MANAGER,
  ]),
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
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.ACCOUNTANT,
    SchoolRole.MANAGER,
  ]),
  async (c) => {
    try {
      const enrollmentId = parseInt(c.req.param("enrollmentId"));
      const schoolCode = c.get("schoolCode")!;

      const history = await getPaymentsForEnrollment(c.env, schoolCode, enrollmentId);

      return c.json({ history });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default feesRouter;
