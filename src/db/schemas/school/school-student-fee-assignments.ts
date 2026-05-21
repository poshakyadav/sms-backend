// src/db/schemas/school/school-student-fee-assignments.ts
/**
 * STUDENT FEE ASSIGNMENTS (Per-Student Custom Fees)
 *
 * Purpose: Class-section fee_structures assign the SAME fees to ALL students
 * in a class. But some fees are inherently per-student:
 *
 *   - TRANSPORT: Zone-based — student in Zone 3 pays ₹800/month, Zone 1 pays ₹400/month
 *   - HOSTEL: Room type — AC room ₹3,000/month, non-AC ₹1,800/month
 *   - SPORTS: Sport chosen — Swimming ₹1,200/quarter, Football ₹600/quarter
 *   - SPECIAL_COACHING: Only specific students enrolled
 *   - LATE_FEE: One-time charge for a specific student
 *   - Any other school-defined custom per-student fee
 *
 * These cannot be modelled as fee_structures (class-section level).
 * This table fills that gap.
 *
 * PAYMENT: fee_payments.studentFeeAssignmentId references this table.
 * fee_payments.feeStructureId is made nullable to support both modes.
 * Exactly ONE of (feeStructureId, studentFeeAssignmentId) must be non-null
 * per payment row — enforced in service layer.
 *
 * MONTH-WISE: For monthly fees (transport, hostel), create one row per month
 * with feeMonth = "YYYY-MM". For one-time fees, leave feeMonth NULL.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolUsersSchema } from "./school-users";

export const schoolStudentFeeAssignmentsSchema = sqliteTable(
  "student_fee_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    // Specific student enrollment this fee is assigned to.
    enrollmentId: integer("enrollment_id")
      .references(() => schoolStudentEnrollmentsSchema.id, {
        onDelete: "cascade",
      })
      .notNull(),

    // Academic year context (denormalised from enrollment for fast dashboard queries).
    academicYearId: integer("academic_year_id")
      .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
      .notNull(),

    // Fee type — free text, school defines their own categories.
    // Common values: "TRANSPORT", "HOSTEL", "SPORTS", "SPECIAL_COACHING", "LATE_FEE"
    // The UI shows a dropdown of previously used types + option to type custom.
    feeType: text("fee_type").notNull(),

    // Custom amount for THIS student (in paise). Fully flexible per student.
    amount: integer("amount").notNull(),

    // Month this fee applies to. "YYYY-MM" format (e.g. "2025-04").
    // NULL for one-time fees (admission fee, late fine, etc.)
    // For monthly transport: create one row per month with feeMonth set.
    feeMonth: text("fee_month"),

    // Payment due date for this specific assignment.
    dueDate: text("due_date"),

    // Human description for this specific student's fee.
    // e.g. "Zone 3 - Kidwai Nagar route, ~8km", "AC Double Room Block B"
    description: text("description"),

    isMandatory: integer("is_mandatory", { mode: "boolean" })
      .default(true)
      .notNull(),

    // Who assigned this fee (accountant / school owner).
    assignedBy: integer("assigned_by")
      .references(() => schoolUsersSchema.id)
      .notNull(),

    // Soft-delete: cancelled fee assignments are preserved for audit.
    // Cancelled assignments do NOT appear in the student's due fees.
    isCancelled: integer("is_cancelled", { mode: "boolean" })
      .default(false)
      .notNull(),

    cancelledAt: text("cancelled_at"),
    cancelledBy: integer("cancelled_by").references(() => schoolUsersSchema.id),
    cancellationReason: text("cancellation_reason"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
  // Note: No unique index on (enrollmentId + feeType + feeMonth) intentionally.
  // A school may legitimately add two transport rows (e.g. mid-month route change).
  // Deduplication is a UI/UX concern, not a DB constraint.
);

export type SchoolStudentFeeAssignment =
  typeof schoolStudentFeeAssignmentsSchema.$inferSelect;
export type NewSchoolStudentFeeAssignment =
  typeof schoolStudentFeeAssignmentsSchema.$inferInsert;
