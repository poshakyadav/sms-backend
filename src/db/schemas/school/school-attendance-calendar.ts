// src/db/schemas/school/school-attendance-calendar.ts

import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE CALENDAR — authoritative source of "is this a working day"
//
// Stores ONLY exceptions to the default (default = every date is a working
// day). One row can cover:
//
//   classSectionId = 0   → SCHOOL-WIDE. Applies to every class-section unless
//                          a specific override exists for that section+date.
//   classSectionId = X   → Applies ONLY to class-section X. Overrides any
//                          school-wide row for the same date (e.g. one
//                          section runs a remedial camp during vacation).
//
// dayType:
//   HOLIDAY      → No attendance expected. Nothing should ever be marked.
//   WORKING_DAY  → Explicit override, used to CANCEL a school-wide holiday
//                  for one specific class-section (rare, but real).
//
// This table is completely decoupled from attendance_sessions. A holiday
// costs ONE row regardless of how many students or class-sections it covers
// — the exact same "store exceptions only" philosophy as `attendances`
// itself, just one level up.
// ─────────────────────────────────────────────────────────────────────────────

export const CalendarDayType = {
  WORKING_DAY: "WORKING_DAY",
  HOLIDAY: "HOLIDAY",
} as const;

export type CalendarDayTypeValue =
  (typeof CalendarDayType)[keyof typeof CalendarDayType];

/** Sentinel classSectionId meaning "applies to the whole school". */
export const SCHOOL_WIDE_CALENDAR_SCOPE = 0;

export const schoolAttendanceCalendarSchema = sqliteTable(
  "attendance_calendar",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    // 0 = school-wide. Any positive value = a specific class-section override.
    // Deliberately NOT nullable + NOT a real FK to class_sections, since 0
    // is a valid sentinel, not a real class-section — enforcing the FK
    // would reject the school-wide rows. Validity of positive IDs is
    // checked in the service layer instead.
    classSectionId: integer("class_section_id").notNull().default(0),

    date: text("date").notNull(), // "YYYY-MM-DD"

    dayType: text("day_type").$type<CalendarDayTypeValue>().notNull(),

    // e.g. "Summer Vacation", "Diwali Break", "Republic Day", "Remedial Camp"
    reason: text("reason").notNull(),

    createdBy: integer("created_by")
      .references(() => schoolUsersSchema.id)
      .notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => ({
    // One ruling per (scope, date) — prevents duplicate/conflicting entries
    uniqueScopeDate: uniqueIndex("uq_calendar_scope_date").on(
      table.classSectionId,
      table.date
    ),
    // Fast range scans for "give me the calendar for this month"
    dateIdx: index("idx_calendar_date").on(table.date),
  })
);

export type SchoolAttendanceCalendar =
  typeof schoolAttendanceCalendarSchema.$inferSelect;
export type NewSchoolAttendanceCalendar =
  typeof schoolAttendanceCalendarSchema.$inferInsert;