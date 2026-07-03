/**
 * src/types/school-permissions.ts
 * PRODUCTION-GRADE PERMISSION SYSTEM
 *
 * Atomic permission slugs (PBAC). Never hard-code strings again.
 * Grouped by module for beautiful Owner Permission Matrix UI.
 * SCHOOL_OWNER gets special '*' wildcard — but ONLY for 'staff' category permissions.
 *
 * ── CATEGORY SYSTEM ───────────────────────────────────────────────────────────
 * Every permission slug belongs to exactly one category:
 *   'staff'   — School Owner wildcard applies. Shown in Owner Permission Matrix.
 *   'student' — Only assignable to STUDENT role. Never given to staff or Owner wildcard.
 *   'parent'  — Only assignable to STUDENT_PARENT role. Never given to staff or Owner wildcard.
 *
 * This prevents the core bug where a Parent gets 'fees.report' and sees the
 * school-wide fee management page instead of their child's fee view.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ── Permission category type ──────────────────────────────────────────────────
export type PermissionCategory = "staff" | "student" | "parent";

export const SCHOOL_PERMISSIONS = {
  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  // category: staff — dashboard is a staff concept; students/parents get
  // their own landing page without needing this permission.
  DASHBOARD: {
    VIEW: "dashboard.view",
  },

  // ── USERS & ROLES MANAGEMENT ──────────────────────────────────────────────
  USERS: {
    LIST: "users.list",
    CREATE: "users.create",
    EDIT: "users.edit",
    DELETE: "users.delete",
    ASSIGN_ROLE: "users.assign-role",
  },

  ROLES: {
    MANAGE: "roles.manage",
  },

  PERMISSIONS: {
    MANAGE: "permissions.manage",
  },

  // ── ACADEMICS ─────────────────────────────────────────────────────────────
  ACADEMICS: {
    YEARS_MANAGE: "academics.years.manage",
    CLASSES_MANAGE: "academics.classes.manage",
    SECTIONS_MANAGE: "academics.sections.manage",
    ENROLL: "academics.enroll",
    UNENROLL: "academics.unenroll",
    SUBJECTS_MANAGE: "academics.subjects.manage",
    ASSIGN_TEACHER: "academics.assign-teacher",
    MAPPINGS_MANAGE: "academics.mappings.manage",
  },

  // ── ATTENDANCE — STAFF ────────────────────────────────────────────────────
  ATTENDANCE: {
    MARK: "attendance.mark", // Teacher marks attendance
    REPORT: "attendance.report", // Staff views class-wide report
    // ── REMOVED from here — moved to STUDENT_PORTAL and PARENT_PORTAL below
    // attendance.student.view was incorrectly a 'staff' slug before this change.
  },

  // ── FEES — STAFF ──────────────────────────────────────────────────────────
  FEES: {
    STRUCTURES_MANAGE: "fees.structures.manage",
    PAYMENTS_RECORD: "fees.payments.record",
    REPORT: "fees.report", // School-wide fee report (staff only)
    LEDGER_VIEW: "fees.ledger.view", // Staff views any student's ledger
  },

  // ── ASSIGNMENTS — STAFF ───────────────────────────────────────────────────
  ASSIGNMENTS: {
    CREATE: "assignments.create",
    EDIT: "assignments.edit",
    DELETE: "assignments.delete",
    SUBMISSIONS_VIEW: "assignments.submissions.view", // Staff/Teacher views all submissions
    GRADE: "assignments.grade",
  },

  // ── EXAMS — STAFF ─────────────────────────────────────────────────────────
  EXAMS: {
    CREATE: "exams.create",
    EDIT: "exams.edit",
    DELETE: "exams.delete",
    MARKS_ENTER: "exams.marks.enter",
    ADMIT_CARD: "exams.admit-card", // Staff generates admit cards
    REPORT_CARD: "exams.report-card", // Staff generates report cards
    ADMIT_CARD_PUBLISH: "exams.admit-card.publish",
    REPORT_CARD_PUBLISH: "exams.report-card.publish",
    TEMPLATES_MANAGE: "exams.templates.manage",
  },

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  NOTIFICATIONS: {
    SEND: "notifications.send",
    VIEW: "notifications.view", // Staff views/manages sent notifications
  },

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  SETTINGS: {
    MANAGE: "settings.manage",
    THEME_MANAGE: "settings.theme.manage",
  },

  // ── BILLING / RAZORPAY — STAFF ───────────────────────────────────────────
  // Controls visibility of the school's own billing screen: current access
  // expiry, payment history, autopay (UPI Autopay) management, and WhatsApp/
  // Email/SMS bundle purchases. category: staff — School Owner wildcard '*'
  // includes this automatically; Accountant role can be granted it directly.
  BILLING: {
    VIEW: "billing.view", // View own school's payment history & access status
    MANAGE: "billing.manage", // Initiate payments, manage autopay, buy bundles
  },

  // ── STUDENTS — STAFF ──────────────────────────────────────────────────────
  STUDENTS: {
    LIST: "students.list",
    PROFILE_MANAGE: "students.profile.manage",
    BULK_UPLOAD: "students.bulk-upload",
  },

  ID_CARDS: {
    GENERATE: "id-cards.generate", // Generate new ID cards (single or bulk)
    VIEW: "id-cards.view", // View issued ID cards / management list
    REVOKE: "id-cards.revoke", // Revoke / reissue an ID card
    PRINT: "id-cards.print", // Export/print ID cards (PDF download access)
    DELETE: "id-cards.delete",
    TEMPLATE_MANAGE: "id-cards.templates.manage", // Create/edit ID card templates (layout config)
  },

  FEED: {
    FEED_POST_CREATE: "feed.post.create",
    FEED_POST_MANAGE :"feed.post.manage",
    FEED_VIEW: "feed.view",
    FEED_REACT: "feed.react",
  },

  // ── TEACHERS ──────────────────────────────────────────────────────────────
  TEACHERS: {
    PROFILE_MANAGE: "teachers.profile.manage",
  },

  // ── PARENTS ───────────────────────────────────────────────────────────────
  PARENTS: {
    MANAGE: "parents.manage",
  },

  // ── SUPPORT / CONTACT ─────────────────────────────────────────────────────
  CONTACT: {
    SUBMIT: "contact.submit",
  },

  // ── FUTURE MODULES ────────────────────────────────────────────────────────
  LIBRARY: { ISSUE: "library.issue", RETURN: "library.return" },
  TRANSPORT: { MANAGE: "transport.manage" },

  // ══════════════════════════════════════════════════════════════════════════
  // STUDENT PORTAL PERMISSIONS (category: 'student')
  // ══════════════════════════════════════════════════════════════════════════
  // These slugs are ONLY assigned to the STUDENT role.
  // They are excluded from the Owner wildcard '*' fetch.
  // Backend routes guarded by these slugs return data scoped to the
  // authenticated user's own enrollment (userId from JWT, no override allowed).
  // ──────────────────────────────────────────────────────────────────────────
  STUDENT_PORTAL: {
    // Dashboard — student's own landing page (not the staff dashboard)
    DASHBOARD: "dashboard.student.view",

    // Profile
    VIEW_OWN_PROFILE: "students.view.own", // Student views their own profile

    // Attendance
    VIEW_OWN_ATTENDANCE: "attendance.student.view", // Student views their own attendance

    // Fees
    VIEW_OWN_FEES: "fees.student.view", // Student views their own fee ledger/history

    // Assignments
    VIEW_OWN_ASSIGNMENTS: "assignments.student.view", // Student views assignments for their class
    SUBMIT_ASSIGNMENT: "assignments.student.submit", // Student marks assignment as done

    // Exams
    VIEW_OWN_MARKS: "exams.student.view", // Student views their own marks
    VIEW_OWN_ADMIT_CARD: "exams.student.admit-card", // Student downloads their own admit card
    VIEW_OWN_REPORT_CARD: "exams.student.report-card", // Student downloads their own report card

    // Notifications
    VIEW_NOTIFICATIONS: "notifications.student.view", // Student views notifications sent to them

    // Feed
    VIEW_FEED: "feed.student.view", // Student views feed posts
    REACT_FEED: "feed.student.react", // Student reacts to feed posts
  },

  // ══════════════════════════════════════════════════════════════════════════
  // PARENT PORTAL PERMISSIONS (category: 'parent')
  // ══════════════════════════════════════════════════════════════════════════
  // These slugs are ONLY assigned to the STUDENT_PARENT role.
  // They are excluded from the Owner wildcard '*' fetch.
  // Backend routes guarded by these slugs use X-Active-Child-Id header
  // (injected by auth-interceptor.ts) to scope data to the selected child.
  // ──────────────────────────────────────────────────────────────────────────
  PARENT_PORTAL: {
    // Dashboard — parent's own landing page (not the staff dashboard)
    DASHBOARD: "dashboard.parent.view",

    // Attendance
    VIEW_CHILD_ATTENDANCE: "attendance.parent.view", // Parent views their child's attendance

    // Fees
    VIEW_CHILD_FEES: "fees.parent.view", // Parent views their child's fee summary

    // Assignments
    VIEW_CHILD_ASSIGNMENTS: "assignments.parent.view", // Parent views child's assignments

    // Exams
    VIEW_CHILD_MARKS: "exams.parent.view", // Parent views child's marks
    VIEW_CHILD_ADMIT_CARD: "exams.parent.admit-card", // Parent downloads child's admit card
    VIEW_CHILD_REPORT_CARD: "exams.parent.report-card", // Parent downloads child's report card

    // Notifications
    VIEW_NOTIFICATIONS: "notifications.parent.view", // Parent views notifications sent to them

    // Feed
    VIEW_FEED: "feed.parent.view", // Parent views feed posts
    REACT_FEED: "feed.parent.react", // Parent reacts to feed posts
  },
} as const;

// ── Derived types ──────────────────────────────────────────────────────────────

export type SchoolPermissionSlug = {
  [K in keyof typeof SCHOOL_PERMISSIONS]: (typeof SCHOOL_PERMISSIONS)[K][keyof (typeof SCHOOL_PERMISSIONS)[K]];
}[keyof typeof SCHOOL_PERMISSIONS];

// Special wildcard (School Owner only — scoped to 'staff' category)
export const WILDCARD_PERMISSION = "*" as const;

/** Union that includes both normal slugs + wildcard */
export type PermissionSlugWithWildcard =
  | SchoolPermissionSlug
  | typeof WILDCARD_PERMISSION;

// ── Slug sets split by category ────────────────────────────────────────────────
// These are used by:
//   1. getUserPermissionsFromDB — Owner wildcard only fetches STAFF_PERMISSION_SLUGS
//   2. syncPermissionsAndRoles  — correct category is written to the DB on sync
//   3. Permission Matrix UI     — only shows staff slugs to the Owner

/** All staff-facing permission slugs. Owner wildcard applies to these only. */
export const STAFF_PERMISSION_SLUGS: readonly SchoolPermissionSlug[] = [
  // Dashboard
  "dashboard.view",

  // Users & Roles
  "users.list",
  "users.create",
  "users.edit",
  "users.delete",
  "users.assign-role",
  "roles.manage",
  "permissions.manage",

  // Academics
  "academics.years.manage",
  "academics.classes.manage",
  "academics.sections.manage",
  "academics.enroll",
  "academics.unenroll",
  "academics.subjects.manage",
  "academics.assign-teacher",
  "academics.mappings.manage",

  // Attendance (staff)
  "attendance.mark",
  "attendance.report",

  // Fees (staff)
  "fees.structures.manage",
  "fees.payments.record",
  "fees.report",
  "fees.ledger.view",

  // Assignments (staff)
  "assignments.create",
  "assignments.edit",
  "assignments.delete",
  "assignments.submissions.view",
  "assignments.grade",

  // Exams (staff)
  "exams.create",
  "exams.edit",
  "exams.delete",
  "exams.marks.enter",
  "exams.admit-card",
  "exams.report-card",
  "exams.admit-card.publish",
  "exams.report-card.publish",
  "exams.templates.manage",

  // Notifications (staff)
  "notifications.send",
  "notifications.view",

  // Feed (staff)
  "feed.post.create",
  "feed.post.manage",
  "feed.view",
  "feed.react",

  // Billing (staff)
  "billing.view",
  "billing.manage",

  // Settings
  "settings.manage",
  "settings.theme.manage",

  // Students management (staff)
  "students.list",
  "students.profile.manage",
  "students.bulk-upload",

  // ID Cards (staff)
  "id-cards.generate",
  "id-cards.view",
  "id-cards.revoke",
  "id-cards.print",
  "id-cards.templates.manage",

  // Teachers, Parents, Contact
  "teachers.profile.manage",
  "parents.manage",
  "contact.submit",

  // Future
  "library.issue",
  "library.return",
  "transport.manage",
] as const;

/** All student-facing permission slugs. Never given to staff or Owner wildcard. */
export const STUDENT_PERMISSION_SLUGS: readonly SchoolPermissionSlug[] = [
  "dashboard.student.view",
  "students.view.own",
  "attendance.student.view",
  "fees.student.view",
  "assignments.student.view",
  "assignments.student.submit",
  "exams.student.view",
  "exams.student.admit-card",
  "exams.student.report-card",
  "notifications.student.view",
  "feed.student.view",
  "feed.student.react",
] as const;

/** All parent-facing permission slugs. Never given to staff or Owner wildcard. */
export const PARENT_PERMISSION_SLUGS: readonly SchoolPermissionSlug[] = [
  "dashboard.parent.view",
  "attendance.parent.view",
  "fees.parent.view",
  "assignments.parent.view",
  "exams.parent.view",
  "exams.parent.admit-card",
  "exams.parent.report-card",
  "notifications.parent.view",
  "feed.parent.view",
  "feed.parent.react",
] as const;

/** All permission slugs across all categories. Used for sync completeness checks. */
export const ALL_PERMISSION_SLUGS: readonly SchoolPermissionSlug[] = [
  ...STAFF_PERMISSION_SLUGS,
  ...STUDENT_PERMISSION_SLUGS,
  ...PARENT_PERMISSION_SLUGS,
] as const;

/**
 * Lookup map: slug → category.
 * Used by syncPermissionsAndRoles to write the correct category to the DB.
 */
export const PERMISSION_CATEGORY_MAP: Readonly<
  Record<SchoolPermissionSlug, PermissionCategory>
> = Object.fromEntries([
  ...STAFF_PERMISSION_SLUGS.map((s) => [s, "staff" as PermissionCategory]),
  ...STUDENT_PERMISSION_SLUGS.map((s) => [s, "student" as PermissionCategory]),
  ...PARENT_PERMISSION_SLUGS.map((s) => [s, "parent" as PermissionCategory]),
]) as Readonly<Record<SchoolPermissionSlug, PermissionCategory>>;

// Helper for UI grouping (Owner Permission Matrix — shows only staff slugs)
export const PERMISSION_GROUPS = SCHOOL_PERMISSIONS;
