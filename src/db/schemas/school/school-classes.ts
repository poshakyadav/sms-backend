import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";

export const schoolClassesSchema = sqliteTable("classes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(), // "Nursery", "Class 1", "10th", "XI"
  level: integer("level").notNull(), // 0 = Nursery, 1, 2, ..., 12
  sort_order: integer("sort_order").notNull(), // for sorting
});

export type SchoolClass = typeof schoolClassesSchema.$inferSelect;
export type NewSchoolClass = typeof schoolClassesSchema.$inferInsert;