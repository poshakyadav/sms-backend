// src/db/schemas/super/school-registration-requests.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { superUsersSchema } from "./super-users";

export const RegistrationRequestStatus = {
  PENDING: "PENDING",
  REVIEWED: "REVIEWED",
  INVITED: "INVITED",
  REJECTED: "REJECTED",
  DUPLICATE: "DUPLICATE",
} as const;

export type RegistrationRequestStatusType =
  keyof typeof RegistrationRequestStatus;

export const SchoolType = {
  PRIMARY: "PRIMARY",
  SECONDARY: "SECONDARY",
  HIGHER_SECONDARY: "HIGHER_SECONDARY",
  OTHER: "OTHER",
} as const;

export type SchoolTypeValue = keyof typeof SchoolType;

export const schoolRegistrationRequestsSchema = sqliteTable(
  "school_registration_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // School info
    schoolName: text("school_name").notNull(),
    schoolType: text("school_type")
      .$type<SchoolTypeValue>()
      .notNull()
      .default("OTHER"),
    city: text("city").notNull().default(""),
    state: text("state").notNull().default(""),
    estimatedStudents: integer("estimated_students"),

    // Owner / contact info
    ownerName: text("owner_name").notNull(),
    ownerEmail: text("owner_email").notNull(),
    ownerPhone: text("owner_phone").notNull().default(""),

    // Optional message from the school
    message: text("message").default(""),

    // Lifecycle
    status: text("status")
      .$type<RegistrationRequestStatusType>()
      .notNull()
      .default("PENDING"),

    // Super admin fields
    internalNotes: text("internal_notes").default(""),
    reviewedBy: integer("reviewed_by").references(() => superUsersSchema.id, {
      onDelete: "set null",
    }),
    reviewedAt: text("reviewed_at"),

    // If this request was converted to a real invitation, store that link
    convertedToInvitationId: integer("converted_to_invitation_id"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type SchoolRegistrationRequest =
  typeof schoolRegistrationRequestsSchema.$inferSelect;
export type NewSchoolRegistrationRequest =
  typeof schoolRegistrationRequestsSchema.$inferInsert;
