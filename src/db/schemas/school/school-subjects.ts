import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const schoolSubjectsSchema = sqliteTable("subjects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  name: text("name").notNull(), // "Math", "Science"
  code: text("code").unique(), // "MATH101" // consider making unique per school later: .unique([schoolId, code])
  description: text("description"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export type SchoolSubject = typeof schoolSubjectsSchema.$inferSelect;
export type NewSchoolSubject = typeof schoolSubjectsSchema.$inferInsert;