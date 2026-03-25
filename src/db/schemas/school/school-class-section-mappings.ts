import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolAcademicYearsSchema } from "./school-academic-years";

export const schoolClassSectionMappingsSchema = sqliteTable("class_section_mappings", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    currentClassSectionId: integer("current_class_section_id")
      .notNull()
      .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" }),
    nextClassSectionId: integer("next_class_section_id")
      .notNull()
      .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" }),
    // Optional: can be year-specific if needed in future
    academicYearId: integer("academic_year_id")
      .references(() => schoolAcademicYearsSchema.id, { onDelete: "cascade" }),
  });
  
  export type SchoolClassSectionMapping = typeof schoolClassSectionMappingsSchema.$inferSelect;
  export type NewSchoolClassSectionMapping = typeof schoolClassSectionMappingsSchema.$inferInsert;