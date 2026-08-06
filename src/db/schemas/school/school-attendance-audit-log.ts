// src/db/schemas/school/school-attendance-audit-log.ts

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolUsersSchema } from "./school-users";
import { AttendanceStatusValue } from "./school-attendances";

/**
 * ATTENDANCE AUDIT LOG — sparse, append-only.
 *
 * A row is written ONLY when a student's status actually changes after
 * the initial mark for that date. Covers all three transitions:
 *   1. implicit PRESENT → exception   (oldStatus = NULL)
 *   2. exception → different exception
 *   3. exception → implicit PRESENT   (newStatus = NULL, row deleted)
 *
 * Cheap by design: edits are a small fraction of an already-small
 * exception set, so this table stays negligible in size.
 */
export const schoolAttendanceAuditLogSchema = sqliteTable(
    "attendance_audit_log",
    {
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

        date: text("date").notNull(),

        oldStatus: text("old_status").$type<AttendanceStatusValue | null>(),
        newStatus: text("new_status").$type<AttendanceStatusValue | null>(),

        changedBy: integer("changed_by")
            .references(() => schoolUsersSchema.id)
            .notNull(),
        changedAt: text("changed_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
    },
    (table) => ({
        enrollmentDateIdx: index("idx_attendance_audit_enrollment_date").on(
            table.enrollmentId,
            table.date
        ),
    })
);

export type SchoolAttendanceAuditLog =
    typeof schoolAttendanceAuditLogSchema.$inferSelect;
export type NewSchoolAttendanceAuditLog =
    typeof schoolAttendanceAuditLogSchema.$inferInsert;