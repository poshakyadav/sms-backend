import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SchoolRole } from "../../../types/school-role";
import { schoolsSchema } from "./schools";

export const schoolUsersSchema = sqliteTable("school_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<SchoolRole>().notNull(),
  phone: text("phone").notNull().default(""),
  alternatePhone: text("alternate_phone").default(""), // Optional second phone number (Alternate contact phone)
  dateOfBirth: text("date_of_birth").default(""), // Added: Common DOB for all users (moved from students for simplicity)
  gender: text("gender").default(""), // Added: Common gender
  addressLineOne: text("address_line_one").default(""), // Address line 1
  addressLineTwo: text("address_line_two").default(""), // Address line 2
  city: text("city").default(""), // City
  state: text("state").default(""), // State/Province
  postalCode: text("postal_code").default(""), // Postal/ZIP code
  bloodGroup: text("blood_group").default(""), // Added: Optional for all, but relevant for students/staff
  avatarUrl: text("avatar_url").default(""), // URL to user avatar image
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SchoolUser = typeof schoolUsersSchema.$inferSelect;
export type NewSchoolUser = typeof schoolUsersSchema.$inferInsert;