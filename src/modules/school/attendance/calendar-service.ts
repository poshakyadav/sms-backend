// src/modules/school/attendance/calendar-service.ts

import { getSchoolDB } from "../../../db/school-client";
import { and, eq, gte, lte, inArray, sql } from "drizzle-orm";
import {
    schoolAttendanceCalendarSchema,
    CalendarDayType,
    CalendarDayTypeValue,
    SCHOOL_WIDE_CALENDAR_SCOPE,
} from "../../../db/schemas/school/school-attendance-calendar";
import {
    schoolAttendanceSessionsSchema,
    schoolClassSectionsSchema,
    schoolsSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGE HELPER
// ─────────────────────────────────────────────────────────────────────────────

function enumerateDates(fromDate: string, toDate: string): string[] {
    const dates: string[] = [];
    const cur = new Date(fromDate + "T00:00:00Z");
    const end = new Date(toDate + "T00:00:00Z");
    while (cur <= end) {
        dates.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY OFF DAYS
// ─────────────────────────────────────────────────────────────────────────────

function parseWeeklyOffDays(raw: string | null | undefined): Set<number> {
    if (!raw) return new Set([0]);
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            return new Set(arr.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
        }
    } catch {
        // fall through
    }
    return new Set([0]);
}

export async function getWeeklyOffDays(
    env: SchoolEnv["Bindings"],
    schoolCode: string
): Promise<number[]> {
    const db = await getSchoolDB(env, schoolCode);
    const school = await db
        .select({ weeklyOffDays: schoolsSchema.weeklyOffDays })
        .from(schoolsSchema)
        .get();
    return Array.from(parseWeeklyOffDays(school?.weeklyOffDays)).sort((a, b) => a - b);
}

export async function setWeeklyOffDays(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    days: number[]
): Promise<{ weeklyOffDays: number[] }> {
    const db = await getSchoolDB(env, schoolCode);
    const unique = Array.from(new Set(days)).sort((a, b) => a - b);
    await db
        .update(schoolsSchema)
        .set({ weeklyOffDays: JSON.stringify(unique), updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(schoolsSchema.id, 1));
    return { weeklyOffDays: unique };
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-DATE DETAILED RESOLUTION
//
// Unlike resolveDayTypesForRange (batch, used for percentage math), this
// resolves ONE (classSectionId, date) pair and reports the SOURCE of the
// resolution, not just the final dayType. This is what lets the frontend
// distinguish "nobody has said anything about this date yet" from
// "this date is a declared holiday" — two states that both need very
// different UI treatment.
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarResolutionSource =
    | "CLASS_SECTION_OVERRIDE"
    | "SCHOOL_WIDE"
    | "WEEKLY_OFF"
    | "DEFAULT_UNMARKED";

export interface CalendarResolution {
    date: string;
    classSectionId: number;
    dayType: CalendarDayTypeValue;
    source: CalendarResolutionSource;
    reason: string | null;
    /** True only for CLASS_SECTION_OVERRIDE / SCHOOL_WIDE — an explicit,
     *  audit-trailed declaration by a real person. WEEKLY_OFF is a standing
     *  rule, not a per-date declaration, so it's deliberately NOT "explicit"
     *  here even though it resolves the day type just fine. */
    isExplicit: boolean;
    calendarEntryId: number | null;
}

export async function resolveDayTypeDetailed(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    classSectionId: number,
    date: string
): Promise<CalendarResolution> {
    const db = await getSchoolDB(env, schoolCode);

    const [specificRow, schoolWideRow, school] = await Promise.all([
        db
            .select()
            .from(schoolAttendanceCalendarSchema)
            .where(
                and(
                    eq(schoolAttendanceCalendarSchema.classSectionId, classSectionId),
                    eq(schoolAttendanceCalendarSchema.date, date)
                )
            )
            .get(),
        db
            .select()
            .from(schoolAttendanceCalendarSchema)
            .where(
                and(
                    eq(schoolAttendanceCalendarSchema.classSectionId, SCHOOL_WIDE_CALENDAR_SCOPE),
                    eq(schoolAttendanceCalendarSchema.date, date)
                )
            )
            .get(),
        db.select({ weeklyOffDays: schoolsSchema.weeklyOffDays }).from(schoolsSchema).get(),
    ]);

    if (specificRow) {
        return {
            date, classSectionId,
            dayType: specificRow.dayType as CalendarDayTypeValue,
            source: "CLASS_SECTION_OVERRIDE",
            reason: specificRow.reason,
            isExplicit: true,
            calendarEntryId: specificRow.id,
        };
    }
    if (schoolWideRow) {
        return {
            date, classSectionId,
            dayType: schoolWideRow.dayType as CalendarDayTypeValue,
            source: "SCHOOL_WIDE",
            reason: schoolWideRow.reason,
            isExplicit: true,
            calendarEntryId: schoolWideRow.id,
        };
    }

    const weeklyOffDays = parseWeeklyOffDays(school?.weeklyOffDays);
    const dayOfWeek = new Date(date + "T00:00:00Z").getUTCDay();
    if (weeklyOffDays.has(dayOfWeek)) {
        return {
            date, classSectionId,
            dayType: CalendarDayType.HOLIDAY,
            source: "WEEKLY_OFF",
            reason: "Weekly off",
            isExplicit: false,
            calendarEntryId: null,
        };
    }

    return {
        date, classSectionId,
        dayType: CalendarDayType.WORKING_DAY,
        source: "DEFAULT_UNMARKED",
        reason: null,
        isExplicit: false,
        calendarEntryId: null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR STATUS CHECK — the gate the mark-attendance screen calls before
// letting a teacher see the student list.
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarCheckResult extends CalendarResolution {
    isSessionMarked: boolean;
    sessionTotalStudents: number | null;
    sessionExceptionCount: number | null;
    /** Only true when the date is resolved (explicitly, or via weekly-off)
     *  AND resolves to a working day. */
    canMarkAttendance: boolean;
    /** True whenever canMarkAttendance is false — the frontend's single
     *  signal for "show the guard state". */
    requiresCalendarAction: boolean;
}

export async function checkCalendarStatus(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    classSectionId: number,
    date: string
): Promise<CalendarCheckResult> {
    const db = await getSchoolDB(env, schoolCode);
    const resolution = await resolveDayTypeDetailed(env, schoolCode, classSectionId, date);

    const session = await db
        .select({
            totalStudents: schoolAttendanceSessionsSchema.totalStudents,
            exceptionCount: schoolAttendanceSessionsSchema.exceptionCount,
        })
        .from(schoolAttendanceSessionsSchema)
        .where(
            and(
                eq(schoolAttendanceSessionsSchema.classSectionId, classSectionId),
                eq(schoolAttendanceSessionsSchema.date, date)
            )
        )
        .get();

    const isResolved = resolution.isExplicit || resolution.source === "WEEKLY_OFF";
    const canMarkAttendance = isResolved && resolution.dayType === CalendarDayType.WORKING_DAY;

    return {
        ...resolution,
        isSessionMarked: session != null,
        sessionTotalStudents: session?.totalStudents ?? null,
        sessionExceptionCount: session?.exceptionCount ?? null,
        canMarkAttendance,
        requiresCalendarAction: !canMarkAttendance,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HOLIDAY IMPACT PREVIEW — read-only. Used by declareHoliday internally AND
// exposed as its own endpoint so the frontend can show a danger dialog
// BEFORE the person commits, not just report a warning after the fact.
// ─────────────────────────────────────────────────────────────────────────────

export interface HolidayImpactPreview {
    scope: "SCHOOL_WIDE" | "CLASS_SECTION";
    classSectionId: number | null;
    fromDate: string;
    toDate: string;
    affectedDates: string[];
    count: number;
}

export async function previewHolidayImpact(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    fromDate: string,
    toDate: string,
    classSectionId?: number
): Promise<HolidayImpactPreview> {
    const db = await getSchoolDB(env, schoolCode);
    const sectionFilter = classSectionId
        ? eq(schoolAttendanceSessionsSchema.classSectionId, classSectionId)
        : undefined;

    const existingSessions = await db
        .select({
            classSectionId: schoolAttendanceSessionsSchema.classSectionId,
            date: schoolAttendanceSessionsSchema.date,
        })
        .from(schoolAttendanceSessionsSchema)
        .where(
            and(
                gte(schoolAttendanceSessionsSchema.date, fromDate),
                lte(schoolAttendanceSessionsSchema.date, toDate),
                sectionFilter
            )
        );

    const uniqueDates = Array.from(new Set(existingSessions.map((s) => s.date))).sort();

    return {
        scope: classSectionId ? "CLASS_SECTION" : "SCHOOL_WIDE",
        classSectionId: classSectionId ?? null,
        fromDate, toDate,
        affectedDates: uniqueDates,
        count: uniqueDates.length,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// DECLARE HOLIDAY (bulk, date range) — now delegates the impact check to
// previewHolidayImpact instead of duplicating the query.
// ─────────────────────────────────────────────────────────────────────────────

export async function declareHoliday(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    data: { fromDate: string; toDate: string; classSectionId?: number; reason: string },
    createdBy: number
) {
    const db = await getSchoolDB(env, schoolCode);
    const scope = data.classSectionId ?? SCHOOL_WIDE_CALENDAR_SCOPE;
    const dates = enumerateDates(data.fromDate, data.toDate);

    if (dates.length > 366) {
        throw new Error("Date range too large — declare holidays in spans of one year or less");
    }

    const impact = await previewHolidayImpact(
        env, schoolCode, data.fromDate, data.toDate, data.classSectionId
    );

    return db.transaction(async (tx) => {
        for (const date of dates) {
            const existing = await tx
                .select({ id: schoolAttendanceCalendarSchema.id })
                .from(schoolAttendanceCalendarSchema)
                .where(
                    and(
                        eq(schoolAttendanceCalendarSchema.classSectionId, scope),
                        eq(schoolAttendanceCalendarSchema.date, date)
                    )
                )
                .get();

            if (existing) {
                await tx
                    .update(schoolAttendanceCalendarSchema)
                    .set({ dayType: CalendarDayType.HOLIDAY, reason: data.reason, createdBy })
                    .where(eq(schoolAttendanceCalendarSchema.id, existing.id));
            } else {
                await tx.insert(schoolAttendanceCalendarSchema).values({
                    classSectionId: scope,
                    date,
                    dayType: CalendarDayType.HOLIDAY,
                    reason: data.reason,
                    createdBy,
                });
            }
        }
        return {
            message: `Declared ${dates.length} day(s) as holiday`,
            count: dates.length,
            existingAttendanceWarning:
                impact.count > 0
                    ? `Attendance was already marked on ${impact.count} day(s) in this range. Those records are kept for audit purposes but will no longer count toward working-day totals or reports.`
                    : null,
            affectedDates: impact.affectedDates,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SET WORKING-DAY OVERRIDE
//
// classSectionId is now OPTIONAL. Two distinct uses:
//   - omitted     → explicit SCHOOL-WIDE "today is a working day" declaration.
//                    Redundant with the default in pure calendar-math terms,
//                    but this is exactly the audit row the new mark-attendance
//                    gate needs: "a real person confirmed this date."
//   - provided    → section-specific override, e.g. cancelling a school-wide
//                    holiday for one section running makeup classes.
// ─────────────────────────────────────────────────────────────────────────────

export async function setWorkingDayOverride(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    data: { fromDate: string; toDate: string; classSectionId?: number; reason?: string },
    createdBy: number
) {
    const db = await getSchoolDB(env, schoolCode);
    const scope = data.classSectionId ?? SCHOOL_WIDE_CALENDAR_SCOPE;
    const dates = enumerateDates(data.fromDate, data.toDate);
    const reason = data.reason?.trim() || "Marked as working day"; // never store blank text

    if (dates.length > 366) {
        throw new Error("Date range too large — set working days in spans of one year or less");
    }

    return db.transaction(async (tx) => {
        for (const date of dates) {
            const existing = await tx
                .select({ id: schoolAttendanceCalendarSchema.id })
                .from(schoolAttendanceCalendarSchema)
                .where(
                    and(
                        eq(schoolAttendanceCalendarSchema.classSectionId, scope),
                        eq(schoolAttendanceCalendarSchema.date, date)
                    )
                )
                .get();

            if (existing) {
                await tx
                    .update(schoolAttendanceCalendarSchema)
                    .set({ dayType: CalendarDayType.WORKING_DAY, reason: data.reason, createdBy })
                    .where(eq(schoolAttendanceCalendarSchema.id, existing.id));
            } else {
                await tx.insert(schoolAttendanceCalendarSchema).values({
                    classSectionId: scope,
                    date,
                    dayType: CalendarDayType.WORKING_DAY,
                    reason,
                    createdBy,
                });
            }
        }
        return {
            message: `Marked ${dates.length} day(s) as working day for ${data.classSectionId ? "this section" : "the whole school"}`,
            count: dates.length,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE A CALENDAR OVERRIDE
// ─────────────────────────────────────────────────────────────────────────────

export async function removeCalendarOverride(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    id: number
) {
    const db = await getSchoolDB(env, schoolCode);
    await db.delete(schoolAttendanceCalendarSchema).where(eq(schoolAttendanceCalendarSchema.id, id));
    return { message: "Calendar override removed" };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE DAY TYPES FOR A RANGE (batch — used by percentage/report math)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveDayTypesForRange(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    classSectionId: number,
    fromDate: string,
    toDate: string
): Promise<Map<string, CalendarDayTypeValue>> {
    const db = await getSchoolDB(env, schoolCode);

    const [rows, school] = await Promise.all([
        db
            .select({
                classSectionId: schoolAttendanceCalendarSchema.classSectionId,
                date: schoolAttendanceCalendarSchema.date,
                dayType: schoolAttendanceCalendarSchema.dayType,
            })
            .from(schoolAttendanceCalendarSchema)
            .where(
                and(
                    inArray(schoolAttendanceCalendarSchema.classSectionId, [
                        classSectionId,
                        SCHOOL_WIDE_CALENDAR_SCOPE,
                    ]),
                    gte(schoolAttendanceCalendarSchema.date, fromDate),
                    lte(schoolAttendanceCalendarSchema.date, toDate)
                )
            ),
        db.select({ weeklyOffDays: schoolsSchema.weeklyOffDays }).from(schoolsSchema).get(),
    ]);

    const weeklyOffDays = parseWeeklyOffDays(school?.weeklyOffDays);

    const specific = new Map<string, CalendarDayTypeValue>();
    const schoolWide = new Map<string, CalendarDayTypeValue>();
    for (const row of rows) {
        if (row.classSectionId === classSectionId) specific.set(row.date, row.dayType as CalendarDayTypeValue);
        else schoolWide.set(row.date, row.dayType as CalendarDayTypeValue);
    }

    const result = new Map<string, CalendarDayTypeValue>();
    for (const date of enumerateDates(fromDate, toDate)) {
        const explicit = specific.get(date) ?? schoolWide.get(date);
        if (explicit) {
            result.set(date, explicit);
            continue;
        }
        const dayOfWeek = new Date(date + "T00:00:00Z").getUTCDay();
        result.set(date, weeklyOffDays.has(dayOfWeek) ? CalendarDayType.HOLIDAY : CalendarDayType.WORKING_DAY);
    }
    return result;
}

export async function countWorkingDaysInRange(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    classSectionId: number,
    fromDate: string,
    toDate: string
): Promise<number> {
    const dayTypes = await resolveDayTypesForRange(env, schoolCode, classSectionId, fromDate, toDate);
    let count = 0;
    for (const type of dayTypes.values()) if (type === CalendarDayType.WORKING_DAY) count++;
    return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// MISSING ATTENDANCE REPORT
// ─────────────────────────────────────────────────────────────────────────────

export interface MissingAttendanceDate {
    date: string;
    classSectionId: number;
    className: string;
}

export async function getMissingAttendanceReport(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    fromDate: string,
    toDate: string,
    classSectionId?: number
): Promise<MissingAttendanceDate[]> {
    const db = await getSchoolDB(env, schoolCode);

    const sections = await db
        .select({ id: schoolClassSectionsSchema.id, roomNumber: schoolClassSectionsSchema.roomNumber })
        .from(schoolClassSectionsSchema)
        .where(
            and(
                eq(schoolClassSectionsSchema.isActive, true),
                classSectionId ? eq(schoolClassSectionsSchema.id, classSectionId) : undefined
            )
        );

    const existingSessions = await db
        .select({
            classSectionId: schoolAttendanceSessionsSchema.classSectionId,
            date: schoolAttendanceSessionsSchema.date,
        })
        .from(schoolAttendanceSessionsSchema)
        .where(
            and(
                gte(schoolAttendanceSessionsSchema.date, fromDate),
                lte(schoolAttendanceSessionsSchema.date, toDate),
                classSectionId ? eq(schoolAttendanceSessionsSchema.classSectionId, classSectionId) : undefined
            )
        );

    const sessionSet = new Set(existingSessions.map((s) => `${s.classSectionId}|${s.date}`));
    const missing: MissingAttendanceDate[] = [];

    for (const section of sections) {
        const dayTypes = await resolveDayTypesForRange(env, schoolCode, section.id, fromDate, toDate);
        for (const [date, type] of dayTypes) {
            if (type !== CalendarDayType.WORKING_DAY) continue;
            if (sessionSet.has(`${section.id}|${date}`)) continue;
            if (date > new Date().toISOString().slice(0, 10)) continue;
            missing.push({ date, classSectionId: section.id, className: section.roomNumber ?? `Section ${section.id}` });
        }
    }
    return missing.sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET CALENDAR ENTRIES — now with friendly scope labels + optional
// classSectionId filter for the Manage Calendar table.
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarEntryRow {
    id: number;
    classSectionId: number;
    date: string;
    dayType: CalendarDayTypeValue;
    reason: string;
    createdBy: number;
    createdAt: string;
    createdByName: string;
    className: string | null;
    sectionName: string | null;
    scopeLabel: string;
}

export async function getCalendarEntries(
    env: SchoolEnv["Bindings"],
    schoolCode: string,
    fromDate: string,
    toDate: string,
    classSectionId?: number
): Promise<CalendarEntryRow[]> {
    const db = await getSchoolDB(env, schoolCode);

    const whereClauses = [
        gte(schoolAttendanceCalendarSchema.date, fromDate),
        lte(schoolAttendanceCalendarSchema.date, toDate),
    ];
    if (classSectionId !== undefined) {
        whereClauses.push(eq(schoolAttendanceCalendarSchema.classSectionId, classSectionId));
    }

    const rows = await db
        .select({
            id: schoolAttendanceCalendarSchema.id,
            classSectionId: schoolAttendanceCalendarSchema.classSectionId,
            date: schoolAttendanceCalendarSchema.date,
            dayType: schoolAttendanceCalendarSchema.dayType,
            reason: schoolAttendanceCalendarSchema.reason,
            createdBy: schoolAttendanceCalendarSchema.createdBy,
            createdAt: schoolAttendanceCalendarSchema.createdAt,
            createdByName: sql<string>`(
                SELECT su.name FROM school_users su WHERE su.id = ${schoolAttendanceCalendarSchema.createdBy}
            )`.as("created_by_name"),
            className: sql<string | null>`(
                SELECT c.name FROM class_sections cs
                JOIN classes c ON c.id = cs.class_id
                WHERE cs.id = ${schoolAttendanceCalendarSchema.classSectionId}
            )`.as("class_name"),
            sectionName: sql<string | null>`(
                SELECT s.name FROM class_sections cs
                JOIN sections s ON s.id = cs.section_id
                WHERE cs.id = ${schoolAttendanceCalendarSchema.classSectionId}
            )`.as("section_name"),
        })
        .from(schoolAttendanceCalendarSchema)
        .where(and(...whereClauses))
        .orderBy(schoolAttendanceCalendarSchema.date);

    return rows.map((r) => ({
        ...(r as any),
        scopeLabel:
            r.classSectionId === SCHOOL_WIDE_CALENDAR_SCOPE
                ? "School-wide"
                : r.className && r.sectionName
                    ? `${r.className} - ${r.sectionName}`
                    : `Section #${r.classSectionId}`,
    }));
}