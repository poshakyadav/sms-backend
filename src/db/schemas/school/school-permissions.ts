import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { PermissionCategory, SchoolPermissionSlug } from "../../../types/school-permissions";

export const schoolPermissionsSchema = sqliteTable(
  "permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    // Atomic permission slug (e.g. "attendance.mark")
    slug: text("slug").$type<SchoolPermissionSlug>().notNull(),

    // Human readable
    name: text("name").notNull(),           // e.g. "Mark Attendance"
    description: text("description").notNull(),

    // For beautiful grouped UI in Owner Matrix
    module: text("module").notNull(),       // e.g. "ATTENDANCE", "USERS"

    /**
     * AUDIENCE CATEGORY — the most important new field.
     *
     * 'staff'   → School-facing permission. Owner wildcard '*' includes these.
     *             Shown in the Owner Permission Matrix for assignment to custom roles.
     *
     * 'student' → Student portal only. NEVER included in Owner wildcard fetch.
     *             Only assignable to the STUDENT system role.
     *             Backend routes use the authenticated user's own ID — no impersonation.
     *
     * 'parent'  → Parent portal only. NEVER included in Owner wildcard fetch.
     *             Only assignable to the STUDENT_PARENT system role.
     *             Backend routes read X-Active-Child-Id header to scope to the child.
     *
     * This column is the single source of truth that prevents the bug where
     * a parent with 'fees.report' sees the school-wide fee management page.
     */
    category: text("category")
      .$type<PermissionCategory>()
      .notNull()
      .default("staff"),

    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => ({
    // One permission slug per school
    uniqueSlugPerSchool: uniqueIndex("uq_permission_slug_per_school").on(
      table.schoolId,
      table.slug
    ),
  })
);

export type SchoolPermission = typeof schoolPermissionsSchema.$inferSelect;
export type NewSchoolPermission = typeof schoolPermissionsSchema.$inferInsert;