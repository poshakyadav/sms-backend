/**
 * @description Defines the access levels and responsibilities within the School Management System.
 * Each role has a specific set of permissions (RBAC).
 */
export enum SchoolRole {
  // ==========================================
  // MANAGEMENT & ADMIN ROLES
  // ==========================================

  /**
   * Highest authority. Access to multi-branch settings,
   * high-level financial audits, and system-wide configurations.
   */
  SCHOOL_OWNER = "SCHOOL_OWNER",

  /**
   * Academic head. Monitors staff performance, school results,
   * and approves major academic decisions/calendars.
   */
  PRINCIPAL = "PRINCIPAL",

  /**
   * Operations head. Manages school infrastructure, procurement,
   * and non-teaching staff logistics.
   */
  MANAGER = "MANAGER",

  /**
   * Front-office role. Manages student inquiries, entrance exams,
   * and the initial registration/onboarding process.
   */
  ADMISSION_OFFICER = "ADMISSION_OFFICER",

  // ==========================================
  // ACADEMIC ROLES
  // ==========================================

  /**
   * Classroom manager. Handles attendance, grading, lesson plans,
   * homework, and direct communication with students/parents.
   */
  TEACHER = "TEACHER",

  // ==========================================
  // SUPPORT / NON-ACADEMIC STAFF
  // ==========================================

  /**
   * Financial controller. Manages fee collection, invoicing,
   * staff payroll, and daily expense logging.
   */
  ACCOUNTANT = "ACCOUNTANT",

  /**
   * Inventory manager for books. Handles book issues, returns,
   * shelf locations, and late-return fine collection.
   */
  LIBRARIAN = "LIBRARIAN",

  /**
   * Logistics coordinator. Manages bus routes, vehicle maintenance,
   * and real-time tracking of student transportation.
   */
  TRANSPORT_STAFF = "TRANSPORT_STAFF",

  /**
   * Campus safety officer. Manages visitor logs, gate passes,
   * and monitors student check-in/check-out times.
   */
  SECURITY_STAFF = "SECURITY_STAFF",

  /**
   * Food services manager. Handles canteen inventory, daily menus,
   * and student meal-card balances/transactions.
   */
  CANTEEN_STAFF = "CANTEEN_STAFF",

  /**
   * Health officer. Manages student medical records, allergies,
   * infirmary visits, and emergency medical contacts.
   */
  SCHOOL_NURSE = "SCHOOL_NURSE",

  // ==========================================
  // FACILITIES & MAINTENANCE (NEW)
  // ==========================================

  /**
   * Cleaning staff (Saaf-Safai). Responsible for classroom hygiene,
   * washroom maintenance, and general cleanliness of the campus.
   */
  HOUSEKEEPING_STAFF = "HOUSEKEEPING_STAFF",

  /**
   * Technical repairs. Handles electrical work, plumbing,
   * furniture repairs, and general building maintenance.
   */
  MAINTENANCE_STAFF = "MAINTENANCE_STAFF",

  /**
   * Grounds & Garden. Manages the school playground,
   * garden areas, and outdoor campus aesthetics.
   */
  GROUNDS_STAFF = "GROUNDS_STAFF",

  /**
   * General helpers/Peons. Assists in moving files,
   * rearranging furniture for events, and general errands.
   */
  UTILITY_STAFF = "UTILITY_STAFF",

  // ==========================================
  // EXTERNAL USERS (CONSUMERS)
  // ==========================================

  /**
   * The learner. Can view personal timetable, grades,
   * submit assignments, and borrow library books.
   */
  STUDENT = "STUDENT",

  /**
   * The guardian. Monitors child's progress, views attendance,
   * receives school announcements, and pays fees online.
   */
  STUDENT_PARENT = "STUDENT_PARENT",

  // Add more roles here later if needed
}

/**
 * INTERNAL ROLES (Staff & Management)
 * These users run the school. They usually have access to the
 * Admin Dashboard or the "Staff App".
 */
export const InternalStaffRoles = [
  SchoolRole.SCHOOL_OWNER,
  SchoolRole.PRINCIPAL,
  SchoolRole.MANAGER,
  SchoolRole.ADMISSION_OFFICER,
  SchoolRole.TEACHER,
  SchoolRole.ACCOUNTANT,
  SchoolRole.LIBRARIAN,
  SchoolRole.TRANSPORT_STAFF,
  SchoolRole.SECURITY_STAFF,
  SchoolRole.CANTEEN_STAFF,
  SchoolRole.SCHOOL_NURSE,
  SchoolRole.HOUSEKEEPING_STAFF,
  SchoolRole.MAINTENANCE_STAFF,
  SchoolRole.GROUNDS_STAFF,
  SchoolRole.UTILITY_STAFF,
] as const;

/**
 * EXTERNAL ROLES (Consumers)
 * These users consume the services. They usually use a
 * separate "Student/Parent Portal".
 */
export const ExternalUserRoles = [
  SchoolRole.STUDENT,
  SchoolRole.STUDENT_PARENT,
] as const;

/**
 *  For roles that have physical school access control
 */
export const OperationsStaffRoles = [
  SchoolRole.SECURITY_STAFF,
  SchoolRole.TRANSPORT_STAFF,
  SchoolRole.CANTEEN_STAFF,
  SchoolRole.HOUSEKEEPING_STAFF,
  SchoolRole.MAINTENANCE_STAFF,
  SchoolRole.GROUNDS_STAFF,
  SchoolRole.UTILITY_STAFF,
] as const;

/**
 * Groups all roles that are considered "employees" of the school.
 * Useful for Payroll, Leave Management, and Internal Staff Dashboards.
 */
export const StaffRoles = [
  SchoolRole.PRINCIPAL,
  SchoolRole.MANAGER,
  SchoolRole.ADMISSION_OFFICER,
  SchoolRole.TEACHER,
  SchoolRole.ACCOUNTANT,
  SchoolRole.LIBRARIAN,
  SchoolRole.TRANSPORT_STAFF,
  SchoolRole.SECURITY_STAFF,
  SchoolRole.CANTEEN_STAFF,
  SchoolRole.SCHOOL_NURSE,
  SchoolRole.HOUSEKEEPING_STAFF,
  SchoolRole.MAINTENANCE_STAFF,
  SchoolRole.GROUNDS_STAFF,
  SchoolRole.UTILITY_STAFF,
] as const;
