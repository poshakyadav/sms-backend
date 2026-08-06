// src/db/schemas/school/school-attendance-sessions.ts

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolUsersSchema } from "./school-users";

/**
 * ATTENDANCE SESSIONS — one row per (class-section, date).
 *
 * This is the anchor for "was attendance taken, by whom, when" — the fact
 * that the exception-only model on `attendances` can no longer represent,
 * since present students never get their own row.
 *
 * totalStudents / exceptionCount are denormalised snapshots, refreshed on
 * every markAttendance() call, so the class list and reports can render
 * "38 present, 2 absent" without re-counting the roster on every read.
 */
export const schoolAttendanceSessionsSchema = sqliteTable(
    "attendance_sessions",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),

        schoolId: integer("school_id")
            .references(() => schoolsSchema.id, { onDelete: "cascade" })
            .notNull()
            .default(1),

        classSectionId: integer("class_section_id")
            .references(() => schoolClassSectionsSchema.id, { onDelete: "cascade" })
            .notNull(),

        date: text("date").notNull(), // "YYYY-MM-DD"

        markedBy: integer("marked_by")
            .references(() => schoolUsersSchema.id)
            .notNull(),
        markedAt: text("marked_at").default(sql`CURRENT_TIMESTAMP`).notNull(),

        // Populated only when the session is touched again after creation.
        lastEditedBy: integer("last_edited_by").references(
            () => schoolUsersSchema.id
        ),
        lastEditedAt: text("last_edited_at"),

        totalStudents: integer("total_students").notNull(),
        exceptionCount: integer("exception_count").notNull().default(0),
    },
    (table) => ({
        uniqueSession: uniqueIndex("uq_attendance_session").on(
            table.classSectionId,
            table.date
        ),
    })
);

export type SchoolAttendanceSession =
    typeof schoolAttendanceSessionsSchema.$inferSelect;
export type NewSchoolAttendanceSession =
    typeof schoolAttendanceSessionsSchema.$inferInsert;