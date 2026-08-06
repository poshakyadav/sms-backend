// …/school/profile/services.ts

import { and, eq, sql } from "drizzle-orm";
import {
  parentsSchema,
  schoolRolesSchema,
  schoolUserRolesSchema,
  schoolUsersSchema,
  staffSchema,
  studentsSchema,
  teachersSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { comparePassword, hashPassword } from "../../../utils/hashing";
import { getProfileCategory } from "../../../utils/school/profile-mapping";
import {
  isValidUsernameFormat,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../../../utils/school/username";
import { isUniqueConstraintError } from "../../../utils/db-errors";

// ==================== GET MY PROFILE ====================
/**
 * Returns the full authenticated user's profile.
 * Detects profile type via table joins (student / teacher / parent / staff).
 * Also returns assigned roles.
 */
export async function getMyProfile(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Base user record with all profile joins
  const userWithProfile = await db
    .select({
      // Base user fields
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      username: schoolUsersSchema.username,
      email: schoolUsersSchema.email, // nullable — email is now optional
      primaryRole: schoolUsersSchema.primaryRole,
      phone: schoolUsersSchema.phone,
      alternatePhone: schoolUsersSchema.alternatePhone,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      gender: schoolUsersSchema.gender,
      bloodGroup: schoolUsersSchema.bloodGroup,
      avatarUrl: schoolUsersSchema.avatarUrl,
      addressLineOne: schoolUsersSchema.addressLineOne,
      addressLineTwo: schoolUsersSchema.addressLineTwo,
      city: schoolUsersSchema.city,
      state: schoolUsersSchema.state,
      postalCode: schoolUsersSchema.postalCode,
      isActive: schoolUsersSchema.isActive,
      createdAt: schoolUsersSchema.createdAt,
      updatedAt: schoolUsersSchema.updatedAt,

      // Profile-specific fields (will be null if role doesn't match)
      // Student
      studentRollNumber: studentsSchema.rollNumber,
      studentAdmissionDate: studentsSchema.admissionDate,
      studentPreviousSchool: studentsSchema.previousSchool,
      studentMedicalInfo: studentsSchema.medicalInfo,

      // Teacher
      teacherQualification: teachersSchema.qualification,
      teacherExperienceYears: teachersSchema.experienceYears,
      teacherJoiningDate: teachersSchema.joiningDate,
      teacherSpecialization: teachersSchema.specialization,

      // Parent
      parentOccupation: parentsSchema.occupation,

      // Staff
      staffDesignation: staffSchema.designation,
      staffDepartment: staffSchema.department,
      staffJoiningDate: staffSchema.joiningDate,
      staffSalary: staffSchema.salary,
      staffShift: staffSchema.shift,
    })
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!userWithProfile) return null;

  // 2. Fetch roles
  const roles = await db
    .select({
      id: schoolRolesSchema.id,
      name: schoolRolesSchema.name,
      description: schoolRolesSchema.description,
      isSystem: schoolRolesSchema.isSystem,
    })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, userId))
    .all();

  // 3. Determine profile type and shape the response
  const profileType = detectProfileType(userWithProfile, userWithProfile.primaryRole ?? "");

  return {
    // Core identity
    id: userWithProfile.id,
    name: userWithProfile.name,
    username: userWithProfile.username,
    email: userWithProfile.email,
    primaryRole: userWithProfile.primaryRole,
    phone: userWithProfile.phone,
    alternatePhone: userWithProfile.alternatePhone,
    dateOfBirth: userWithProfile.dateOfBirth,
    gender: userWithProfile.gender,
    bloodGroup: userWithProfile.bloodGroup,
    avatarUrl: userWithProfile.avatarUrl,
    addressLineOne: userWithProfile.addressLineOne,
    addressLineTwo: userWithProfile.addressLineTwo,
    city: userWithProfile.city,
    state: userWithProfile.state,
    postalCode: userWithProfile.postalCode,
    isActive: userWithProfile.isActive,
    createdAt: userWithProfile.createdAt,
    updatedAt: userWithProfile.updatedAt,

    // Role info
    roles,
    profileType,

    // Role-specific extra data (only populated for the matching profile)
    profileData: buildProfileData(profileType, userWithProfile),
  };
}

// ==================== UPDATE MY PROFILE ====================
export async function updateMyProfile(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  data: {
    name?: string;
    phone?: string;
    alternatePhone?: string;
    dateOfBirth?: string;
    gender?: string;
    bloodGroup?: string;
    avatarUrl?: string;
    addressLineOne?: string;
    addressLineTwo?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  const updateData: any = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  // Only include fields that are explicitly provided
  if (data.name !== undefined) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.alternatePhone !== undefined)
    updateData.alternatePhone = data.alternatePhone;
  if (data.dateOfBirth !== undefined) updateData.dateOfBirth = data.dateOfBirth;
  if (data.gender !== undefined) updateData.gender = data.gender;
  if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
  if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;
  if (data.addressLineOne !== undefined)
    updateData.addressLineOne = data.addressLineOne;
  if (data.addressLineTwo !== undefined)
    updateData.addressLineTwo = data.addressLineTwo;
  if (data.city !== undefined) updateData.city = data.city;
  if (data.state !== undefined) updateData.state = data.state;
  if (data.postalCode !== undefined) updateData.postalCode = data.postalCode;

  if (Object.keys(updateData).length <= 1) {
    // Only updatedAt — nothing to do
    return { message: "No changes provided" };
  }

  await db
    .update(schoolUsersSchema)
    .set(updateData)
    .where(eq(schoolUsersSchema.id, userId));

  return { message: "Profile updated successfully" };
}

// ==================== CHANGE MY USERNAME ====================
/**
 * Self-service username change for the authenticated user.
 *
 * Mirrors changeSchoolUserUsername() in the users module (same normalize →
 * format-check → optimistic-write → unique-constraint-catch pattern), but:
 *   - is scoped to the CALLER's own account (no :id param, no admin permission)
 *   - requires current password verification, matching changeMyPassword /
 *     changeMyEmail, since the username doubles as a login credential.
 *
 * Deliberately does NOT bump tokenVersion — the JWT does not encode the
 * username, so existing sessions stay valid. The user only needs the new
 * username the next time they log in.
 */
export async function changeMyUsername(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  newUsername: string,
  currentPassword: string
): Promise<{ username: string }> {
  const db = await getSchoolDB(env, schoolCode);

  const normalized = normalizeUsername(newUsername);
  if (!isValidUsernameFormat(normalized)) {
    throw new Error(
      `Invalid username. Usernames must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter, and contain only lowercase letters and numbers.`
    );
  }

  const user = await db
    .select({
      id: schoolUsersSchema.id,
      username: schoolUsersSchema.username,
      passwordHash: schoolUsersSchema.passwordHash,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found");

  const isValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isValid) {
    throw new Error("Current password is incorrect");
  }

  if (user.username === normalized) {
    throw new Error("New username is the same as your current username");
  }

  try {
    await db
      .update(schoolUsersSchema)
      .set({ username: normalized, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schoolUsersSchema.id, userId));
  } catch (err: any) {
    if (isUniqueConstraintError(err, "username")) {
      throw new Error(
        "This username is already taken. Please choose a different one."
      );
    }
    throw err;
  }

  return { username: normalized };
}

// ==================== CHANGE MY PASSWORD ====================
export async function changeMyPassword(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  currentPassword: string,
  newPassword: string
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Fetch current hash
  const user = await db
    .select({
      id: schoolUsersSchema.id,
      passwordHash: schoolUsersSchema.passwordHash,
      tokenVersion: schoolUsersSchema.tokenVersion,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found");

  // 2. Verify current password
  const isValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isValid) {
    throw new Error("Current password is incorrect");
  }

  // 3. Hash new password
  const newHash = await hashPassword(newPassword);

  // 4. Update password + increment tokenVersion (invalidates all existing sessions)
  await db
    .update(schoolUsersSchema)
    .set({
      passwordHash: newHash,
      tokenVersion: user.tokenVersion + 1,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolUsersSchema.id, userId));

  return { message: "Password changed successfully" };
}

// ==================== CHANGE MY EMAIL ====================
export async function changeMyEmail(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  newEmail: string,
  currentPassword: string
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Fetch current user
  const user = await db
    .select({
      id: schoolUsersSchema.id,
      email: schoolUsersSchema.email, // nullable — user may not have one yet
      passwordHash: schoolUsersSchema.passwordHash,
      tokenVersion: schoolUsersSchema.tokenVersion,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, userId))
    .get();

  if (!user) throw new Error("User not found");

  // 2. Verify password before email change (security requirement)
  const isValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isValid) {
    throw new Error("Password is incorrect");
  }

  // 3. Check new email is not the same as current
  if (user.email === newEmail) {
    throw new Error("New email is the same as your current email");
  }

  // 4. CRITICAL: Check new email is not already taken by another user
  const emailConflict = await db
    .select({ id: schoolUsersSchema.id })
    .from(schoolUsersSchema)
    .where(
      and(
        eq(schoolUsersSchema.email, newEmail),
        sql`${schoolUsersSchema.id} != ${userId}`
      )
    )
    .get();

  if (emailConflict) {
    throw new Error(
      "This email address is already in use by another account. Please choose a different email."
    );
  }

  // 5. Update email + increment tokenVersion (invalidates all existing sessions)
  await db
    .update(schoolUsersSchema)
    .set({
      email: newEmail,
      tokenVersion: user.tokenVersion + 1,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolUsersSchema.id, userId));

  return { message: "Email changed successfully" };
}

// ==================== HELPERS ====================

type ProfileType = "student" | "teacher" | "parent" | "staff" | "unknown";

function detectProfileType(row: any, primaryRole: string): ProfileType {
  const category = getProfileCategory(primaryRole);

  switch (category) {
    case "student":
      if (row.studentRollNumber !== null || row.studentAdmissionDate !== null)
        return "student";
      break;
    case "teacher":
      if (row.teacherQualification !== null || row.teacherExperienceYears !== null)
        return "teacher";
      break;
    case "parent":
      if (row.parentOccupation !== null) return "parent";
      break;
    case "staff":
      if (row.staffDesignation !== null) return "staff";
      break;
  }

  return category as ProfileType;
}

function buildProfileData(type: ProfileType, row: any) {
  switch (type) {
    case "student":
      return {
        type: "student",
        rollNumber: row.studentRollNumber,
        admissionDate: row.studentAdmissionDate,
        previousSchool: row.studentPreviousSchool,
        medicalInfo: row.studentMedicalInfo,
      };
    case "teacher":
      return {
        type: "teacher",
        qualification: row.teacherQualification,
        experienceYears: row.teacherExperienceYears,
        joiningDate: row.teacherJoiningDate,
        specialization: row.teacherSpecialization,
      };
    case "parent":
      return {
        type: "parent",
        occupation: row.parentOccupation,
      };
    case "staff":
      return {
        type: "staff",
        designation: row.staffDesignation,
        department: row.staffDepartment,
        joiningDate: row.staffJoiningDate,
        salary: row.staffSalary,
        shift: row.staffShift,
      };
    default:
      return null;
  }
}