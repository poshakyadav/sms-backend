import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { PermissionCategory } from "../../../types/school-permissions";

export const schoolRolesSchema = sqliteTable(
  "roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    name: text("name").notNull(), // e.g. "Senior Teacher", "SCHOOL_OWNER"
    description: text("description").notNull(),
    isSystem: integer("is_system", { mode: "boolean" })
      .default(false)
      .notNull(), // protects built-in roles

    /**
     * PERMISSION UNIVERSE CATEGORY
     *
     * Determines which permission universe this role belongs to.
     * This is immutable after role creation — changing it would require
     * auditing every user assigned to the role and migrating their permissions.
     *
     * 'staff'   → Role is for school staff. Only staff-category permissions
     *             can be assigned. Shown in the Owner Permission Matrix.
     *
     * 'student' → Role is for students only. Only student-category permissions
     *             can be assigned. Only one system role: STUDENT.
     *
     * 'parent'  → Role is for parents/guardians only. Only parent-category
     *             permissions can be assigned. Only one system role: STUDENT_PARENT.
     *
     * Custom roles created by school owners are ALWAYS 'staff' or a category
     * explicitly chosen at creation time. The category cannot be changed after
     * creation (enforced by the update endpoint).
     *
     * Default: 'staff' — ensures all pre-migration custom roles remain valid.
     */
    category: text("category")
      .$type<PermissionCategory>()
      .notNull()
      .default("staff"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Role name must be unique per school
    uniqueRoleNamePerSchool: uniqueIndex("uq_role_name_per_school").on(
      table.schoolId,
      table.name
    ),
  })
);

export type SchoolRoleRecord = typeof schoolRolesSchema.$inferSelect;
export type NewSchoolRoleRecord = typeof schoolRolesSchema.$inferInsert;
