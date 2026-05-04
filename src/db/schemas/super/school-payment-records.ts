import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { superUsersSchema } from "./super-users";
import { schoolsSchema } from "./schools";
import { schoolInvitationsSchema } from "./school-invitations";

export const PaymentRecordStatus = {
  SUBMITTED: "SUBMITTED", // School submitted UTR / screenshot
  VERIFIED: "VERIFIED", // Super admin confirmed payment
  REJECTED: "REJECTED", // Super admin rejected — school can resubmit
} as const;

export type PaymentRecordStatusType = keyof typeof PaymentRecordStatus;

export const schoolPaymentRecordsSchema = sqliteTable(
  "school_payment_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Which school and which invitation this payment belongs to
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),
    invitationId: integer("invitation_id")
      .references(() => schoolInvitationsSchema.id, { onDelete: "cascade" })
      .notNull(),

    // Amount is snapshotted at time of invitation (fee may change later)
    amountExpected: integer("amount_expected").notNull(), // paise
    amountPaid: integer("amount_paid"), // paise — filled by school

    // UTR (Unified Transaction Reference) — from UPI transaction
    utrNumber: text("utr_number"), // 12-digit reference from UPI app

    // Optional proof screenshot
    screenshotUrl: text("screenshot_url"),

    // Payer details
    payerName: text("payer_name"),
    payerPhone: text("payer_phone"),
    submittedAt: text("submitted_at"), // When school hit "I've paid"

    status: text("status")
      .$type<PaymentRecordStatusType>()
      .notNull()
      .default("SUBMITTED"),

    // Verification / rejection
    verifiedBy: integer("verified_by").references(() => superUsersSchema.id, {
      onDelete: "set null",
    }),
    verifiedAt: text("verified_at"),
    rejectionReason: text("rejection_reason"),
    internalNotes: text("internal_notes"), // Super admin's private notes

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type SchoolPaymentRecord =
  typeof schoolPaymentRecordsSchema.$inferSelect;
export type NewSchoolPaymentRecord =
  typeof schoolPaymentRecordsSchema.$inferInsert;
