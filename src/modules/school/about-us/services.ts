// src/modules/school/about-us/services.ts
// ─────────────────────────────────────────────────────────────────────────────
// About Us service
//   getAboutUs   — GET singleton; auto-seeds empty row on first call
//   upsertAboutUs — PUT partial update; only supplied keys are written
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { schoolAboutUsSchema } from "../../../db/schemas/school/school-about-us";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

// ── Shared public type (used by routes too) ───────────────────────────────────
export interface AboutUsData {
  id: number;
  schoolId: number;
  description: string;
  mission: string;
  vision: string;
  foundedYear: number | null;
  foundedBy: string;
  history: string;
  affiliationBoard: string;
  affiliationNumber: string;
  accreditation: string;
  totalStudents: number | null;
  totalTeachers: number | null;
  totalStaff: number | null;
  campusAreaAcres: string;
  principalName: string;
  principalMessage: string;
  principalAvatarUrl: string;
  facebookUrl: string;
  twitterUrl: string;
  instagramUrl: string;
  youtubeUrl: string;
  linkedinUrl: string;
  facilities: string[];
  galleryUrls: string[];
  coreValues: { title: string; description: string }[];
  achievements: { year?: number; title: string; description: string }[];
  createdAt: string;
  updatedAt: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToData(row: typeof schoolAboutUsSchema.$inferSelect): AboutUsData {
  return {
    id: row.id,
    schoolId: row.schoolId,
    description: row.description ?? "",
    mission: row.mission ?? "",
    vision: row.vision ?? "",
    foundedYear: row.foundedYear ?? null,
    foundedBy: row.foundedBy ?? "",
    history: row.history ?? "",
    affiliationBoard: row.affiliationBoard ?? "",
    affiliationNumber: row.affiliationNumber ?? "",
    accreditation: row.accreditation ?? "",
    totalStudents: row.totalStudents ?? null,
    totalTeachers: row.totalTeachers ?? null,
    totalStaff: row.totalStaff ?? null,
    campusAreaAcres: row.campusAreaAcres ?? "",
    principalName: row.principalName ?? "",
    principalMessage: row.principalMessage ?? "",
    principalAvatarUrl: row.principalAvatarUrl ?? "",
    facebookUrl: row.facebookUrl ?? "",
    twitterUrl: row.twitterUrl ?? "",
    instagramUrl: row.instagramUrl ?? "",
    youtubeUrl: row.youtubeUrl ?? "",
    linkedinUrl: row.linkedinUrl ?? "",
    facilities: safeParseJson<string[]>(row.facilities, []),
    galleryUrls: safeParseJson<string[]>(row.galleryUrls, []),
    coreValues: safeParseJson<{ title: string; description: string }[]>(
      row.coreValues,
      []
    ),
    achievements: safeParseJson<
      { year?: number; title: string; description: string }[]
    >(row.achievements, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── SCHOOL_ID constant — always 1 per isolated school DB ─────────────────────
const SCHOOL_ID = 1;

// ══════════════════════════════════════════════════════════════════════════════
// GET — singleton with auto-seed
// ══════════════════════════════════════════════════════════════════════════════
export async function getAboutUs(
  env: SchoolEnv["Bindings"],
  schoolCode: string
): Promise<AboutUsData> {
  const db = await getSchoolDB(env, schoolCode);

  let row = await db
    .select()
    .from(schoolAboutUsSchema)
    .where(eq(schoolAboutUsSchema.schoolId, SCHOOL_ID))
    .get();

  // Auto-seed empty singleton on first read — idempotent
  if (!row) {
    const results = await db
      .insert(schoolAboutUsSchema)
      .values({ schoolId: SCHOOL_ID })
      .returning();
    row = results[0];
  }

  return rowToData(row);
}

// ══════════════════════════════════════════════════════════════════════════════
// UPSERT — partial update, only supplied keys are written to DB
// ══════════════════════════════════════════════════════════════════════════════

export type UpsertAboutUsInput = {
  description?: string;
  mission?: string;
  vision?: string;
  foundedYear?: number | null;
  foundedBy?: string;
  history?: string;
  affiliationBoard?: string;
  affiliationNumber?: string;
  accreditation?: string;
  totalStudents?: number | null;
  totalTeachers?: number | null;
  totalStaff?: number | null;
  campusAreaAcres?: string;
  principalName?: string;
  principalMessage?: string;
  principalAvatarUrl?: string;
  facebookUrl?: string;
  twitterUrl?: string;
  instagramUrl?: string;
  youtubeUrl?: string;
  linkedinUrl?: string;
  facilities?: string[];
  galleryUrls?: string[];
  coreValues?: { title: string; description: string }[];
  achievements?: { year?: number; title: string; description: string }[];
};

export async function upsertAboutUs(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: UpsertAboutUsInput
): Promise<AboutUsData> {
  const db = await getSchoolDB(env, schoolCode);

  // Check whether the singleton row exists
  const existing = await db
    .select({ id: schoolAboutUsSchema.id })
    .from(schoolAboutUsSchema)
    .where(eq(schoolAboutUsSchema.schoolId, SCHOOL_ID))
    .get();

  // Build partial payload — only include keys the caller supplied
  const payload: Record<string, unknown> = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  if (data.description !== undefined) payload.description = data.description;
  if (data.mission !== undefined) payload.mission = data.mission;
  if (data.vision !== undefined) payload.vision = data.vision;
  if (data.foundedYear !== undefined) payload.foundedYear = data.foundedYear;
  if (data.foundedBy !== undefined) payload.foundedBy = data.foundedBy;
  if (data.history !== undefined) payload.history = data.history;
  if (data.affiliationBoard !== undefined)
    payload.affiliationBoard = data.affiliationBoard;
  if (data.affiliationNumber !== undefined)
    payload.affiliationNumber = data.affiliationNumber;
  if (data.accreditation !== undefined)
    payload.accreditation = data.accreditation;
  if (data.totalStudents !== undefined)
    payload.totalStudents = data.totalStudents;
  if (data.totalTeachers !== undefined)
    payload.totalTeachers = data.totalTeachers;
  if (data.totalStaff !== undefined) payload.totalStaff = data.totalStaff;
  if (data.campusAreaAcres !== undefined)
    payload.campusAreaAcres = data.campusAreaAcres;
  if (data.principalName !== undefined)
    payload.principalName = data.principalName;
  if (data.principalMessage !== undefined)
    payload.principalMessage = data.principalMessage;
  if (data.principalAvatarUrl !== undefined)
    payload.principalAvatarUrl = data.principalAvatarUrl;
  if (data.facebookUrl !== undefined) payload.facebookUrl = data.facebookUrl;
  if (data.twitterUrl !== undefined) payload.twitterUrl = data.twitterUrl;
  if (data.instagramUrl !== undefined) payload.instagramUrl = data.instagramUrl;
  if (data.youtubeUrl !== undefined) payload.youtubeUrl = data.youtubeUrl;
  if (data.linkedinUrl !== undefined) payload.linkedinUrl = data.linkedinUrl;
  if (data.facilities !== undefined)
    payload.facilities = JSON.stringify(data.facilities);
  if (data.galleryUrls !== undefined)
    payload.galleryUrls = JSON.stringify(data.galleryUrls);
  if (data.coreValues !== undefined)
    payload.coreValues = JSON.stringify(data.coreValues);
  if (data.achievements !== undefined)
    payload.achievements = JSON.stringify(data.achievements);

  if (existing) {
    await db
      .update(schoolAboutUsSchema)
      .set(payload as any)
      .where(eq(schoolAboutUsSchema.schoolId, SCHOOL_ID));
  } else {
    await db
      .insert(schoolAboutUsSchema)
      .values({ schoolId: SCHOOL_ID, ...(payload as any) });
  }

  // Return the freshly persisted row
  return getAboutUs(env, schoolCode);
}
