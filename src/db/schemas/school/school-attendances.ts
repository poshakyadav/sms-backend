import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const schoolAttendancesSchema = sqliteTable("attendances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  enrollmentId: integer("enrollment_id")
    .references(() => schoolStudentEnrollmentsSchema.id, {
      onDelete: "cascade",
    })
    .notNull(),
  date: text("date").notNull(), // "2026-02-14"
  status: text("status").notNull().default("PRESENT"), // "PRESENT", "ABSENT", "LATE", "HALF_DAY"
  notes: text("notes"),
  markedBy: integer("marked_by")
    .references(() => schoolUsersSchema.id)
    .notNull(), // Teacher ID
  createdAt: text("created_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: text("updated_at")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SchoolAttendance = typeof schoolAttendancesSchema.$inferSelect;
export type NewSchoolAttendance = typeof schoolAttendancesSchema.$inferInsert;
