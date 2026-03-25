import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolsSchema } from "./schools";

export const schoolSectionsSchema = sqliteTable("sections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(), // "A", "B", "Science", "Commerce"
});

export type SchoolSection = typeof schoolSectionsSchema.$inferSelect;
export type NewSchoolSection = typeof schoolSectionsSchema.$inferInsert;