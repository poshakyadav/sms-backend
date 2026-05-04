import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { superUsersSchema } from "./super-users";

export const InvitationStatus = {
  PENDING: "PENDING", // Invitation sent, school has not registered yet
  REGISTERED: "REGISTERED", // School registered, awaiting payment
  PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED", // School submitted payment proof
  PAYMENT_APPROVED: "PAYMENT_APPROVED", // Super admin approved payment
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;

export type InvitationStatusType = keyof typeof InvitationStatus;

export const schoolInvitationsSchema = sqliteTable(
  "school_invitations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    inviteToken: text("invite_token").notNull(), // UUID used in registration link
    schoolName: text("school_name").notNull(),
    schoolEmail: text("school_email").notNull(),
    schoolPhone: text("school_phone").default(""),
    city: text("city").default(""),
    notes: text("notes").default(""), // Internal notes from team member
    status: text("status")
      .$type<InvitationStatusType>()
      .notNull()
      .default("PENDING"),
    invitedBy: integer("invited_by").references(() => superUsersSchema.id, {
      onDelete: "set null",
    }),

    /**
     * ISO timestamp of when the school owner accepted T&C during registration.
     * This is stored in the invitation so the approval service can write it
     * into the provisioned school DB user record at activation time.
     */
    ownerTermsAcceptedAt: text("owner_terms_accepted_at"), // ISO timestamp

    expiresAt: text("expires_at").notNull(), // ISO timestamp
    registeredAt: text("registered_at"), // When school completed signup
    schoolId: integer("school_id"), // Set after school is created in schools table
    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    uniqueToken: uniqueIndex("uq_invite_token").on(table.inviteToken),
  })
);

export type SchoolInvitation = typeof schoolInvitationsSchema.$inferSelect;
export type NewSchoolInvitation = typeof schoolInvitationsSchema.$inferInsert;
