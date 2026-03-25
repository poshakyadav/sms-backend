import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";
import { schoolClassesSchema } from "./school-classes";
import { schoolSectionsSchema } from "./school-sections";
import { schoolUsersSchema } from "./school-users";
import { sql } from "drizzle-orm";

export const schoolClassSectionsSchema = sqliteTable(
  "class_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    classId: integer("class_id")
      .references(() => schoolClassesSchema.id, { onDelete: "cascade" })
      .notNull(),
    sectionId: integer("section_id")
      .references(() => schoolSectionsSchema.id, { onDelete: "cascade" })
      .notNull(),

    // === PRODUCTION-GRADE METADATA ===
    capacity: integer("capacity").default(40).notNull(), // max students
    classTeacherId: integer("class_teacher_id").references(
      () => schoolUsersSchema.id,
      { onDelete: "set null" }
    ), // Teacher (role check in app)
    roomNumber: text("room_number"),

    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Enforce only one "Class 1 - A" per school
    uniqueClassSection: uniqueIndex("uq_class_section").on(
      table.schoolId,
      table.classId,
      table.sectionId
    ),
  })
);

export type SchoolClassSection = typeof schoolClassSectionsSchema.$inferSelect;
export type NewSchoolClassSection =
  typeof schoolClassSectionsSchema.$inferInsert;
