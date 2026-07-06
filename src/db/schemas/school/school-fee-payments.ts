// src/db/schemas/school/school-fee-payments.ts  (UPDATED)
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolFeeStructuresSchema } from "./school-fee-structures";
import { schoolStudentFeeAssignmentsSchema } from "./school-student-fee-assignments";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const schoolFeePaymentsSchema = sqliteTable("fee_payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  enrollmentId: integer("enrollment_id")
    .references(() => schoolStudentEnrollmentsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(),

  // ── PAYMENT SOURCE (exactly one must be non-null) ────────────────────────
  // For class-section fee structure payments:
  feeStructureId: integer("fee_structure_id").references(
    () => schoolFeeStructuresSchema.id,
    { onDelete: "cascade" }
  ),
  // CHANGED: was .notNull() — now nullable to support student fee assignments

  // For per-student custom fee payments (transport, hostel, etc.):
  studentFeeAssignmentId: integer("student_fee_assignment_id").references(
    () => schoolStudentFeeAssignmentsSchema.id,
    { onDelete: "cascade" }
  ),
  // NEW column

  amountPaid: integer("amount_paid").notNull(),
  paymentDate: text("payment_date")
    .default(sql`CURRENT_DATE`)
    .notNull(),
    paymentMethod: text("payment_method")
    .$type<"CASH" | "CHECK" | "BANK_TRANSFER">()
    .default("CASH")
    .notNull(), // "CASH" | "CHECK" | "BANK_TRANSFER"
  receiptNumber: text("receipt_number").unique().notNull(),
  // ── NEW ─────────────────────────────────────────────────────────────────
  // Generated once per recordFeePayment() call (crypto.randomUUID()) and
  // stamped on every row inserted during that call. Lets the receipt
  // endpoint reconstruct "everything paid in one checkout" even when a
  // single submission covers several fee structures/assignments.
  // NULL on any row inserted before this migration — treated as a
  // "batch of one" by the receipt service, so no backfill is required.
  batchId: text("batch_id"),
  notes: text("notes"),
  recordedBy: integer("recorded_by")
    .references(() => schoolUsersSchema.id)
    .notNull(),
  isVoid: integer("is_void", { mode: "boolean" }).default(false).notNull(),
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolFeePayment = typeof schoolFeePaymentsSchema.$inferSelect;
export type NewSchoolFeePayment = typeof schoolFeePaymentsSchema.$inferInsert;
