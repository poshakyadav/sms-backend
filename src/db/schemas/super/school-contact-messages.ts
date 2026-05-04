// src/db/schemas/super/school-contact-messages.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { superUsersSchema } from "./super-users";
import { schoolsSchema } from "./schools";

export const ContactMessageStatus = {
  OPEN: "OPEN",
  IN_REVIEW: "IN_REVIEW",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
} as const;

export type ContactMessageStatusType = keyof typeof ContactMessageStatus;

export const ContactCategory = {
  TECHNICAL_ISSUE: "TECHNICAL_ISSUE",
  BILLING: "BILLING",
  FEATURE_REQUEST: "FEATURE_REQUEST",
  ACCOUNT_ISSUE: "ACCOUNT_ISSUE",
  OTHER: "OTHER",
} as const;

export type ContactCategoryType = keyof typeof ContactCategory;

export const schoolContactMessagesSchema = sqliteTable(
  "school_contact_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // School reference (from super DB)
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),
    schoolCode: text("school_code").notNull(),
    schoolName: text("school_name").notNull().default(""),

    // Owner info (snapshot at time of message)
    ownerUserId: integer("owner_user_id").notNull(), // school_users.id (cross-DB, no FK)
    ownerName: text("owner_name").notNull().default(""),
    ownerEmail: text("owner_email").notNull().default(""),
    ownerPhone: text("owner_phone").default(""),

    // Message content
    category: text("category")
      .$type<ContactCategoryType>()
      .notNull()
      .default("OTHER"),
    subject: text("subject").notNull(),
    message: text("message").notNull(),

    // Lifecycle
    status: text("status")
      .$type<ContactMessageStatusType>()
      .notNull()
      .default("OPEN"),

    // Super admin fields
    internalNotes: text("internal_notes").default(""),
    resolvedBy: integer("resolved_by").references(() => superUsersSchema.id, {
      onDelete: "set null",
    }),
    resolvedAt: text("resolved_at"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  }
);

export type SchoolContactMessage =
  typeof schoolContactMessagesSchema.$inferSelect;
export type NewSchoolContactMessage =
  typeof schoolContactMessagesSchema.$inferInsert;
