import { count, eq, and, sql } from "drizzle-orm";
import {
  superUsersSchema,
  superRolesSchema,
  superUserRolesSchema,
  schoolsSchema,
  tursoDatabasesSchema,
} from "../../../db/schemas/super";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  users: {
    total: number;
    active: number;
    inactive: number;
    byRole: { roleName: string; count: number }[];
  };
  schools: {
    total: number;
    active: number;
    inactive: number;
    withDatabase: number;
    withoutDatabase: number;
  };
  databases: {
    total: number;
    assigned: number;
    available: number;
  };
  generatedAt: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function getDashboardStats(db: any): Promise<DashboardStats> {
  // Run all independent queries in parallel — never sequentially
  const [
    userStats,
    schoolStats,
    dbStats,
    usersByRole,
  ] = await Promise.all([
    getUserStats(db),
    getSchoolStats(db),
    getDatabaseStats(db),
    getUsersByRole(db),
  ]);

  return {
    users: {
      ...userStats,
      byRole: usersByRole,
    },
    schools: schoolStats,
    databases: dbStats,
    generatedAt: new Date().toISOString(),
  };
}

// ── Individual stat queries ───────────────────────────────────────────────────

async function getUserStats(db: any) {
  const [totalRow, activeRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(superUsersSchema)
      .get(),
    db
      .select({ value: count() })
      .from(superUsersSchema)
      .where(eq(superUsersSchema.isActive, true))
      .get(),
  ]);

  const total = totalRow?.value ?? 0;
  const active = activeRow?.value ?? 0;

  return {
    total,
    active,
    inactive: total - active,
  };
}

async function getSchoolStats(db: any) {
  const [totalRow, activeRow, withDbRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(schoolsSchema)
      .get(),
    db
      .select({ value: count() })
      .from(schoolsSchema)
      .where(eq(schoolsSchema.isActive, true))
      .get(),
    db
      .select({ value: count() })
      .from(schoolsSchema)
      .where(sql`${schoolsSchema.tursoDbId} IS NOT NULL`)
      .get(),
  ]);

  const total = totalRow?.value ?? 0;
  const active = activeRow?.value ?? 0;
  const withDatabase = withDbRow?.value ?? 0;

  return {
    total,
    active,
    inactive: total - active,
    withDatabase,
    withoutDatabase: total - withDatabase,
  };
}

async function getDatabaseStats(db: any) {
  const [totalRow, assignedRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(tursoDatabasesSchema)
      .get(),
    db
      .select({ value: count() })
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.isAssigned, true))
      .get(),
  ]);

  const total = totalRow?.value ?? 0;
  const assigned = assignedRow?.value ?? 0;

  return {
    total,
    assigned,
    available: total - assigned,
  };
}

async function getUsersByRole(db: any): Promise<{ roleName: string; count: number }[]> {
  const rows = await db
    .select({
      roleName: superRolesSchema.name,
      count: count(),
    })
    .from(superUserRolesSchema)
    .innerJoin(
      superRolesSchema,
      eq(superUserRolesSchema.roleId, superRolesSchema.id)
    )
    .groupBy(superRolesSchema.name)
    .all();

  return rows.map((r: any) => ({
    roleName: r.roleName as string,
    count: r.count as number,
  }));
}