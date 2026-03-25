import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolAcademicYearsSchema } from "./school-academic-years";
import { schoolsSchema } from "./schools";
import { schoolClassSectionsSchema } from "./school-class-sections";

export const schoolExamsSchema = sqliteTable("exams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  academicYearId: integer("academic_year_id")
    .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" })
    .notNull(),
  // === NOW PER CLASS-SECTION (your requirement) ===
  classSectionId: integer("class_section_id")
    .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
    .notNull(),

  name: text("name").notNull(), // "Mid-Term Exam 2026"
  type: text("type").notNull(), // "MID_TERM", "FINAL", "QUIZ"
  description: text("description"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SchoolExam = typeof schoolExamsSchema.$inferSelect;
export type NewSchoolExam = typeof schoolExamsSchema.$inferInsert;
