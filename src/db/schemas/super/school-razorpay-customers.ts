// src/db/schemas/super/school-razorpay-customers.ts

import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

/**
 * SCHOOL ↔ RAZORPAY CUSTOMER MAPPING
 *
 * Razorpay's Subscriptions API requires a `customer_id` to create a
 * Subscription. This table maps each school to its Razorpay Customer.
 *
 * IMPORTANT: This table is ONLY populated for schools that opt into the
 * AUTOPAY_CHARGE rail. A school that only ever uses manual one-time Orders
 * (the default, expected path for most of your audience) will NEVER get a
 * row here — there is no need for a Razorpay Customer object on the Orders
 * rail at all (orders can optionally carry customer details inline without
 * a persistent Customer resource).
 *
 * Created lazily, once, the first time a school clicks "enable auto-renew"
 * on the billing screen — see school/payments/access/services.ts →
 * ensureRazorpayCustomerForSchool().
 */
export const schoolRazorpayCustomersSchema = sqliteTable(
  "school_razorpay_customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull(),

    /** Razorpay Customer ID, e.g. "cust_xxxxxxxxxxxxx" */
    razorpayCustomerId: text("razorpay_customer_id").notNull(),

    /** Snapshot of the email/phone used at creation time, for audit/debug. */
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // One Razorpay customer per school — never create a second one.
    uniqueSchoolId: uniqueIndex("uq_school_razorpay_customer_school").on(
      table.schoolId
    ),
  })
);

export type SchoolRazorpayCustomer =
  typeof schoolRazorpayCustomersSchema.$inferSelect;
export type NewSchoolRazorpayCustomer =
  typeof schoolRazorpayCustomersSchema.$inferInsert;
