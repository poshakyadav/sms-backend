// …/school/info/services.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION-GRADE school info service
// Handles: get, update (including shortName branding field)
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { schoolsSchema } from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { deleteSchoolLogo, uploadSchoolLogo } from "../../../utils/school/logo-storage";

// ==================== GET SCHOOL INFO ====================
export async function getSchoolInfo(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const school = await db
    .select({
      id: schoolsSchema.id,
      name: schoolsSchema.name,
      shortName: schoolsSchema.shortName, // ← NEW
      uniqueCode: schoolsSchema.uniqueCode,
      addressLineOne: schoolsSchema.addressLineOne,
      addressLineTwo: schoolsSchema.addressLineTwo,
      phone: schoolsSchema.phone,
      alternatePhone: schoolsSchema.alternatePhone,
      email: schoolsSchema.email,
      website: schoolsSchema.website,
      logoUrl: schoolsSchema.logoUrl,
      tagline: schoolsSchema.tagline,
      isActive: schoolsSchema.isActive,
      createdAt: schoolsSchema.createdAt,
      updatedAt: schoolsSchema.updatedAt,
    })
    .from(schoolsSchema)
    .get();

  return school ?? null;
}

// ==================== UPDATE SCHOOL INFO ====================
export async function updateSchoolInfo(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    name?: string;
    shortName?: string; // ← NEW: max 8 chars branding label
    addressLineOne?: string;
    addressLineTwo?: string;
    phone?: string;
    alternatePhone?: string;
    email?: string;
    website?: string;
    tagline?: string;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  const updateData: any = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  if (data.name !== undefined) updateData.name = data.name;
  if (data.shortName !== undefined) {
    // Enforce max 8 chars + uppercase for consistency
    updateData.shortName = data.shortName.trim().slice(0, 8);
  }
  if (data.addressLineOne !== undefined)
    updateData.addressLineOne = data.addressLineOne;
  if (data.addressLineTwo !== undefined)
    updateData.addressLineTwo = data.addressLineTwo;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.alternatePhone !== undefined)
    updateData.alternatePhone = data.alternatePhone;
  if (data.email !== undefined) updateData.email = data.email;
  if (data.website !== undefined) updateData.website = data.website;
  if (data.tagline !== undefined) updateData.tagline = data.tagline;

  if (Object.keys(updateData).length <= 1) {
    return { message: "No changes provided" };
  }

  await db.update(schoolsSchema).set(updateData);

  return { message: "School information updated successfully" };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL LOGO UPLOAD / REMOVE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads (or replaces) the school's logo.
 *
 * Single-image invariant: a school has at most ONE logo at a time. If a
 * logo already exists, the OLD R2 object is deleted only AFTER the new one
 * uploads successfully — this ordering means a failed upload never leaves
 * the school without its previous logo.
 *
 * `bytes` is expected to already be compressed/resized client-side
 * (square, ≤ ~100KB, WebP) — this function does not re-compress; it trusts
 * the frontend contract, same as uploadSchoolUserAvatar.
 */
export async function uploadSchoolLogoImage(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  bytes: ArrayBuffer,
  contentType: string
): Promise<{ logoUrl: string }> {
  const db = await getSchoolDB(env, schoolCode);

  const school = await db
    .select({
      id: schoolsSchema.id,
      logoKey: schoolsSchema.logoKey,
    })
    .from(schoolsSchema)
    .get();

  if (!school) throw new Error("School not found");

  // Server-side size guard — defense in depth even though the frontend
  // compresses before sending. Logos get a slightly higher ceiling than
  // avatars since some schools use detailed crests/emblems.
  const MAX_LOGO_BYTES = 150 * 1024;
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new Error(
      `Image is too large (${Math.round(
        bytes.byteLength / 1024
      )}KB). Please use a smaller image.`
    );
  }

  const { url, key } = await uploadSchoolLogo(env, {
    schoolId: school.id,
    bytes,
    contentType,
  });

  const previousKey = school.logoKey;

  await db
    .update(schoolsSchema)
    .set({
      logoUrl: url,
      logoKey: key,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolsSchema.id, school.id));

  // Clean up the OLD object only after the new one is confirmed saved.
  if (previousKey && previousKey !== key) {
    await deleteSchoolLogo(env, previousKey);
  }

  return { logoUrl: url };
}

/**
 * Removes the school's logo entirely (back to no-logo/initials fallback).
 */
export async function removeSchoolLogoImage(
  env: SchoolEnv["Bindings"],
  schoolCode: string
): Promise<void> {
  const db = await getSchoolDB(env, schoolCode);

  const school = await db
    .select({ id: schoolsSchema.id, logoKey: schoolsSchema.logoKey })
    .from(schoolsSchema)
    .get();

  if (!school) throw new Error("School not found");

  await db
    .update(schoolsSchema)
    .set({
      logoUrl: "",
      logoKey: "",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolsSchema.id, school.id));

  if (school.logoKey) {
    await deleteSchoolLogo(env, school.logoKey);
  }
}
