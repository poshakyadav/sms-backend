import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolFeeStructuresSchema } from "./school-fee-structures";
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
  feeStructureId: integer("fee_structure_id")
    .references(() => schoolFeeStructuresSchema.id, { onDelete: "cascade" })
    .notNull(),
  amountPaid: integer("amount_paid").notNull(),
  paymentDate: text("payment_date")
    .default(sql`CURRENT_DATE`)
    .notNull(),
  paymentMethod: text("payment_method").default("CASH").notNull(), // "CASH", "CHECK", "BANK_TRANSFER"
  receiptNumber: text("receipt_number").unique().notNull(),
  notes: text("notes"),
  recordedBy: integer("recorded_by")
    .references(() => schoolUsersSchema.id)
    .notNull(), // Accountant ID
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
