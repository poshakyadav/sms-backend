// src/db/schemas/school/school-fee-concessions.ts
/**
 * FEE CONCESSIONS (Per-Student Discounts)
 *
 *
 * The "one active concession per enrollment+feeStructure" rule is now
 * enforced EXCLUSIVELY in the service layer (createConcession checks for an
 * existing row where isActive = true before inserting). The DB no longer has
 * a blanket unique constraint that blocks re-issuing.
 *
 * AUDIT TRAIL: All revoked rows are preserved. The historical record is intact.
 *
 * ASSIGNMENT-LEVEL CONCESSIONS (NEW):
 * The studentFeeAssignmentId column allows concessions to be applied to
 * per-student custom fees (transport, hostel, etc.) in addition to
 * class-section fee structures. Exactly ONE of (feeStructureId,
 * studentFeeAssignmentId) must be non-null per row — enforced in the
 * service layer (createConcession).
 */

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolFeeStructuresSchema } from "./school-fee-structures";
import { schoolStudentFeeAssignmentsSchema } from "./school-student-fee-assignments";
import { schoolUsersSchema } from "./school-users";

export const schoolFeeConcessionsSchema = sqliteTable(
  "fee_concessions",
  {
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

    // ── CONCESSION SOURCE (exactly one must be non-null) ──────────────────────
    // For class-section fee structure concessions:
    feeStructureId: integer("fee_structure_id").references(
      () => schoolFeeStructuresSchema.id,
      { onDelete: "cascade" }
    ),
    // nullable — set when this is a structure-level concession

    // For per-student custom fee assignment concessions (transport, hostel, etc.):
    studentFeeAssignmentId: integer("student_fee_assignment_id").references(
      () => schoolStudentFeeAssignmentsSchema.id,
      {
        onDelete: "cascade",
      }
    ),
    // nullable — set when this is an assignment-level concession
    // INVARIANT: exactly ONE of (feeStructureId, studentFeeAssignmentId)
    // must be non-null. Enforced in service layer createConcession().

    // PERCENTAGE → concessionValue is 0–100 (e.g. 20 means 20% off)
    // FIXED      → concessionValue is absolute paise (e.g. 50000 means ₹500 off)
    concessionType: text("concession_type")
      .$type<"PERCENTAGE" | "FIXED">()
      .notNull(),

    concessionValue: integer("concession_value").notNull(),

    reason: text("reason").notNull(),

    approvedBy: integer("approved_by")
      .references(() => schoolUsersSchema.id)
      .notNull(),

    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),

    revokedAt: text("revoked_at"),
    revokedBy: integer("revoked_by").references(() => schoolUsersSchema.id),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Non-unique index for fast lookups of active structure-level concessions.
    enrollmentFeeIdx: index("idx_concession_enrollment_fee").on(
      table.enrollmentId,
      table.feeStructureId,
      table.isActive
    ),
    // Non-unique index for fast lookups of active assignment-level concessions.
    enrollmentAssignmentIdx: index("idx_concession_enrollment_assignment").on(
      table.enrollmentId,
      table.studentFeeAssignmentId,
      table.isActive
    ),
  })
);

export type SchoolFeeConcession =
  typeof schoolFeeConcessionsSchema.$inferSelect;
export type NewSchoolFeeConcession =
  typeof schoolFeeConcessionsSchema.$inferInsert;

export type ConcessionType = "PERCENTAGE" | "FIXED";
