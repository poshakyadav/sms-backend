// src/utils/school/profile-mapping.ts

import { SchoolRole } from "../../types/school-role";

/**
 * PROFILE TABLE CATEGORY
 * Maps a role name to the appropriate profile table.
 *
 * This is the SINGLE SOURCE OF TRUTH for profile routing.
 * Referenced by: createSchoolUser, updateSchoolUser, getMyProfile,
 *                approvals provisioning, and any future profile endpoints.
 *
 * Rule:
 *   STUDENT        → students table
 *   TEACHER        → teachers table
 *   STUDENT_PARENT → parents table
 *   Everything else → staff table (includes SCHOOL_OWNER, PRINCIPAL, MANAGER, etc.)
 */
export type ProfileTableCategory = "student" | "teacher" | "parent" | "staff";

export function getProfileCategory(roleName: string): ProfileTableCategory {
  const upper = roleName.toUpperCase().trim();

  // Exact matches for the three non-staff profile types
  if (upper === SchoolRole.STUDENT) return "student";
  if (upper === SchoolRole.TEACHER) return "teacher";
  if (upper === SchoolRole.STUDENT_PARENT) return "parent";

  // ALL other roles → staff table
  // This covers: SCHOOL_OWNER, PRINCIPAL, MANAGER, ADMISSION_OFFICER,
  // ACCOUNTANT, LIBRARIAN, TRANSPORT_STAFF, SECURITY_STAFF, CANTEEN_STAFF,
  // SCHOOL_NURSE, HOUSEKEEPING_STAFF, MAINTENANCE_STAFF, GROUNDS_STAFF,
  // UTILITY_STAFF, and any custom roles the school creates.
  return "staff";
}

/**
 * Returns a human-readable label for the profile type.
 * Used in error messages and email notifications.
 */
export function getProfileCategoryLabel(roleName: string): string {
  const category = getProfileCategory(roleName);
  const labels: Record<ProfileTableCategory, string> = {
    student: "Student",
    teacher: "Teacher",
    parent: "Parent / Guardian",
    staff: "Staff Member",
  };
  return labels[category];
}

/**
 * Validates that a given role name is a known system role.
 * Custom roles created by the school owner are NOT in this list,
 * and will always map to the "staff" category.
 */
export function isSystemRole(roleName: string): boolean {
  return Object.values(SchoolRole).includes(roleName as SchoolRole);
}
