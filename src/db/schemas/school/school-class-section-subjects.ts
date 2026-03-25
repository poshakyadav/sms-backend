import { integer, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
import { schoolSubjectsSchema } from "./school-subjects";
import { schoolsSchema } from "./schools";
import { schoolClassSectionsSchema } from "./school-class-sections";

/// Many-to-Many: Subjects assigned to Class-Sections (production-grade)
// Different sections of the same class can have different subjects.
export const schoolClassSectionSubjectsSchema = sqliteTable(
  "class_subjects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),
    // === Now points to the real class-section entity ===
    classSectionId: integer("class_section_id")
      .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
      .notNull(),
    subjectId: integer("subject_id")
      .references(() => schoolSubjectsSchema.id, { onDelete: "cascade" })
      .notNull(),
    isMandatory: integer("is_mandatory", { mode: "boolean" })
      .default(true)
      .notNull(),
  },
  (table) => ({
    // Prevent same subject being assigned twice to the same class-section
    uniqueClassSectionSubject: uniqueIndex("uq_class_section_subject").on(
      table.classSectionId,
      table.subjectId
    ),
  })
);

export type SchoolClassSubject = typeof schoolClassSectionSubjectsSchema.$inferSelect;
export type NewSchoolClassSubject =
  typeof schoolClassSectionSubjectsSchema.$inferInsert;
