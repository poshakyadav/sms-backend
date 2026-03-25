import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const schoolCardTemplatesSchema = sqliteTable("card_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),

  type: text("type").notNull(), // "ADMIT_CARD" or "REPORT_CARD"
  name: text("name").notNull(), // e.g. "Official Mid-Term Admit Card 2026"

  // Full HTML + Tailwind template with {{placeholders}}
  htmlContent: text("html_content").notNull(),

  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

// Only one active template per type per school
// (enforced in code)
export type SchoolCardTemplate = typeof schoolCardTemplatesSchema.$inferSelect;
export type NewSchoolCardTemplate =
  typeof schoolCardTemplatesSchema.$inferInsert;
