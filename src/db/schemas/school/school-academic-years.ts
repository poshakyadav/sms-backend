import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { sql } from "drizzle-orm";

export const schoolAcademicYearsSchema = sqliteTable("academic_years", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(), // "2025-2026"
  startDate: text("start_date").notNull(), // "2025-04-01"
  endDate: text("end_date").notNull(),
  isCurrent: integer("is_current", { mode: "boolean" }).default(false).notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// No constraint object — handle in code

export type SchoolAcademicYear = typeof schoolAcademicYearsSchema.$inferSelect;
export type NewSchoolAcademicYear = typeof schoolAcademicYearsSchema.$inferInsert;