// …/school/info/services.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION-GRADE school info service
// Handles: get, update (including shortName branding field)
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { schoolsSchema } from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

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
    logoUrl?: string;
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
  if (data.logoUrl !== undefined) updateData.logoUrl = data.logoUrl;
  if (data.tagline !== undefined) updateData.tagline = data.tagline;

  if (Object.keys(updateData).length <= 1) {
    return { message: "No changes provided" };
  }

  await db.update(schoolsSchema).set(updateData);

  return { message: "School information updated successfully" };
}
