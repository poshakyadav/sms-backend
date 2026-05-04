import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolClassesSchema } from "./school-classes";
import { schoolSectionsSchema } from "./school-sections";
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

  // === Fee structure is now directly tied to class-section ===
  classSectionId: integer("class_section_id")
    .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
    .notNull(),

  feeType: text("fee_type").notNull(), // "TUITION", "BUS", "LIBRARY", "ADMISSION"
  amount: integer("amount").notNull(),
  dueDate: text("due_date"), // "2026-04-15"
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
