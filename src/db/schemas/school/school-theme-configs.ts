import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";

export const schoolThemeConfigsSchema = sqliteTable(
  "school_theme_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id").notNull().default(1),

    // Theme metadata
    themeName: text("theme_name").notNull(), // e.g. "Forest Green", "Royal Purple"

    // Full theme configuration as JSON (production-grade design tokens)
    config: text("config").notNull(), // JSON string containing all CSS variables

    // Distinguish between predefined and custom themes
    isCustomTheme: integer("is_custom_theme", { mode: "boolean" })
      .default(false)
      .notNull(),

    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // ✅ CORRECT: Only ONE active theme per school is allowed.
    // This is a partial unique index — only rows where is_active = 1
    // are constrained. Inactive themes are unlimited.
    oneActiveThemePerSchool: uniqueIndex("uq_school_active_theme")
      .on(table.schoolId)
      .where(sql`${table.isActive} = 1`),
  })
);

export type SchoolThemeConfig = typeof schoolThemeConfigsSchema.$inferSelect;
export type NewSchoolThemeConfig = typeof schoolThemeConfigsSchema.$inferInsert;
