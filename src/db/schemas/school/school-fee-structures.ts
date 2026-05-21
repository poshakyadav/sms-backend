// src/db/schemas/school/school-fee-structures.ts  (UPDATED)
/**
 * FEE STRUCTURES (Class-Section Level)
 *
 * CHANGES FROM ORIGINAL:
 *   - Added `feeMonth` TEXT field for month-wise installment tracking.
 *     Format: "YYYY-MM" (e.g. "2025-04" for April 2025)
 *     NULL = one-time fee (admission, annual lab fee, etc.)
 *     Non-null = monthly installment fee (tuition per month, etc.)
 *
 * This single addition enables month-wise fee display without any other
 * schema changes. Existing rows (with feeMonth = NULL) continue to work
 * as before — they simply display without a month label.
 *
 * BULK CREATION: Use the POST /fees/structures/bulk-monthly endpoint
 * to create 12 monthly rows in one API call instead of one by one.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolsSchema } from "./schools";

export const schoolFeeStructuresSchema = sqliteTable("fee_structures", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  academicYearId: integer("academic_year_id")
    .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
    .notNull(),

  classSectionId: integer("class_section_id")
    .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
    .notNull(),

  feeType: text("fee_type").notNull(), // "TUITION", "LIBRARY", "ADMISSION", etc.
  amount: integer("amount").notNull(), // in paise

  // ── NEW: Month-wise installment support ────────────────────────────────────
  // "YYYY-MM" format. NULL = one-time fee (no month).
  // For monthly tuition: one row per month, feeMonth = "2025-04", "2025-05", etc.
  // Frontend groups fee breakdown by feeMonth for the month-wise calendar view.
  feeMonth: text("fee_month"), // e.g. "2025-04" | null

  dueDate: text("due_date"), // "2026-04-10"
  isMandatory: integer("is_mandatory", { mode: "boolean" })
    .default(true)
    .notNull(),
  description: text("description"),
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolFeeStructure = typeof schoolFeeStructuresSchema.$inferSelect;
export type NewSchoolFeeStructure =
  typeof schoolFeeStructuresSchema.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// src/db/schemas/school/school-fee-payments.ts  (UPDATED)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * FEE PAYMENTS (UPDATED)
 *
 * CHANGES FROM ORIGINAL:
 *   - `feeStructureId` is now NULLABLE (was NOT NULL).
 *     Payments against class-section fee structures still use feeStructureId.
 *     Payments against per-student fee assignments use studentFeeAssignmentId.
 *
 *   - Added `studentFeeAssignmentId` FK → student_fee_assignments.id
 *     This is nullable; set when payment is for a transport/hostel/custom fee.
 *
 * INVARIANT (enforced in service layer):
 *   Exactly ONE of (feeStructureId, studentFeeAssignmentId) must be non-null.
 *   Both null = invalid. Both non-null = invalid.
 *   This is a CHECK constraint in spirit; SQLite doesn't enforce complex checks
 *   natively, so we enforce it in recordFeePayment().
 */
