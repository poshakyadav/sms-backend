// src/db/schemas/super/schools.ts

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tursoDatabasesSchema } from "./turso-databases";

/**
 * Onboarding lifecycle for a school:
 *   INVITED             → Invitation created, email sent
 *   REGISTERED          → School completed signup, payment pending
 *   PAYMENT_SUBMITTED   → School submitted UTR / payment proof
 *   ACTIVE              → Super admin approved payment, Turso DB provisioned
 *   SUSPENDED           → Account suspended post-activation
 */
export const OnboardingStatus = {
  INVITED: "INVITED",
  REGISTERED: "REGISTERED",
  PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export type OnboardingStatusType = keyof typeof OnboardingStatus;

export const schoolsSchema = sqliteTable("schools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // school name
  uniqueCode: text("unique_code").notNull().unique(), // e.g., 'GH33052'
  email: text("email").notNull().unique(), // School owner's email
  addressLineOne: text("address_line_one").notNull().default(""), // school address
  addressLineTwo: text("address_line_two").default(""), // optional second line for school address
  phone: text("phone").notNull().default(""), // school phone
  alternatePhone: text("alternate_phone").default(""), // optional alternate phone
  tursoDbId: integer("turso_db_id").references(() => tursoDatabasesSchema.id, {
    onDelete: "set null",
  }),
  logoUrl: text("logo_url"),

  // ── MVP Payment / Onboarding lifecycle ──────────────────────────────────
  onboardingStatus: text("onboarding_status")
    .$type<OnboardingStatusType>()
    .notNull()
    .default("INVITED"),
  activatedAt: text("activated_at"),
  isActive: integer("is_active", { mode: "boolean" }).default(false).notNull(), // false until payment approved
  createdAt: text("created_at")
    .notNull()
    .default("")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type School = typeof schoolsSchema.$inferSelect;
export type NewSchool = typeof schoolsSchema.$inferInsert;
