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
    CALENDER_MANAGE: "attendance.calendar.manage", // Staff manages attendance calendar (holidays, working-day overrides)

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
    FEED_POST_MANAGE: "feed.post.manage",
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
  "attendance.calendar.manage",

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
  "id-cards.delete",
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

// ======

// ══════════════════════════════════════════════════════════════════════════
// PERMISSION METADATA — human-facing copy, enriched onto DB rows at read time
// ══════════════════════════════════════════════════════════════════════════
// This is the single source of truth for what each permission means to a
// school admin. It is NOT persisted to the DB — `/school/permissions` and
// any endpoint that returns permission objects merge this in by slug at
// request time. Editing copy here takes effect on next deploy, no per-school
// migration needed.
//
// Typed as Record<SchoolPermissionSlug, PermissionMeta> deliberately: if you
// add a new slug to SCHOOL_PERMISSIONS/STAFF_PERMISSION_SLUGS/etc. and forget
// to add an entry here, the project will not compile. That's the enforcement
// mechanism — no separate test needed.

export type PermissionRiskLevel = "low" | "medium" | "high" | "critical";

export interface PermissionMeta {
  /** Human-authored short name shown instead of the mechanical slug title-case. */
  label: string;
  /** One plain-English sentence: what this lets the user do. */
  description: string;
  /** UI hint for how carefully this should be granted. Tune to taste. */
  riskLevel: PermissionRiskLevel;
  /**
   * Short labels naming the screens/features that consume this permission.
   * Purely informational — helps a non-technical admin connect a permission
   * to something they'd actually recognize in the app. Keep each entry to
   * 2-4 words; this renders as small chips in the picker, not prose.
   */
  usedIn: string[];
}

export const PERMISSION_METADATA: Readonly < Record < SchoolPermissionSlug, PermissionMeta >
> = {
  // ── DASHBOARD ──────────────────────────────────────────────────────────
  "dashboard.view": {
    label: "View staff dashboard",
      description: "See the school-wide staff dashboard with attendance, fee, and activity summaries.",
        riskLevel: "low",
          usedIn: ["Staff Dashboard"],
  },

  // ── USERS & ROLES ─────────────────────────────────────────────────────
  "users.list": {
    label: "View users",
      description: "See the list of all staff, students, and parents in the school.",
        riskLevel: "low",
          usedIn: ["Users List"],
  },
  "users.create": {
    label: "Create users",
      description: "Add new staff, student, or parent accounts to the school.",
        riskLevel: "medium",
          usedIn: ["User Creation Hub"],
  },
  "users.edit": {
    label: "Edit users",
      description: "Change any user's profile details, contact info, and account status.",
        riskLevel: "medium",
          usedIn: ["Edit User"],
  },
  "users.delete": {
    label: "Delete users",
      description: "Permanently remove a user account and its records. This cannot be undone.",
        riskLevel: "critical",
          usedIn: ["Users List"],
  },
  "users.assign-role": {
    label: "Assign roles",
      description: "Change which roles a user holds, which changes what they can access.",
        riskLevel: "high",
          usedIn: ["Edit User — Roles"],
  },
  "roles.manage": {
    label: "Manage roles",
      description: "Create, edit, and delete custom roles, and choose which permissions each role grants.",
        riskLevel: "critical",
          usedIn: ["Roles Management"],
  },
  "permissions.manage": {
    label: "Manage permission overrides",
      description: "Grant or block individual permissions for a specific user, beyond their assigned roles.",
        riskLevel: "critical",
          usedIn: ["Edit User — Permission Overrides"],
  },

  // ── ACADEMICS ─────────────────────────────────────────────────────────
  "academics.years.manage": {
    label: "Manage academic years",
      description: "Create and configure academic years for the school.",
        riskLevel: "medium",
          usedIn: ["Academic Years"],
  },
  "academics.classes.manage": {
    label: "Manage classes",
      description: "Create and edit the school's classes (grades).",
        riskLevel: "medium",
          usedIn: ["Classes"],
  },
  "academics.sections.manage": {
    label: "Manage sections",
      description: "Create and edit sections within a class.",
        riskLevel: "medium",
          usedIn: ["Sections"],
  },
  "academics.enroll": {
    label: "Enroll students",
      description: "Enroll students into a class-section for an academic year.",
        riskLevel: "medium",
          usedIn: ["Student Enrollment"],
  },
  "academics.unenroll": {
    label: "Unenroll students",
      description: "Remove a student's enrollment from a class-section.",
        riskLevel: "high",
          usedIn: ["Student Enrollment"],
  },
  "academics.subjects.manage": {
    label: "Manage subjects",
      description: "Create and edit the subjects taught at the school.",
        riskLevel: "medium",
          usedIn: ["Subjects"],
  },
  "academics.assign-teacher": {
    label: "Assign teachers",
      description: "Assign teachers to subjects and class-sections.",
        riskLevel: "medium",
          usedIn: ["Teacher Assignment"],
  },
  "academics.mappings.manage": {
    label: "Manage subject mappings",
      description: "Configure which subjects apply to which classes.",
        riskLevel: "medium",
          usedIn: ["Subject Mappings"],
  },

  // ── ATTENDANCE ────────────────────────────────────────────────────────
  "attendance.mark": {
    label: "Mark attendance",
      description: "Record daily attendance for a class-section.",
        riskLevel: "low",
          usedIn: ["Mark Attendance"],
  },
  "attendance.report": {
    label: "View attendance reports",
      description: "See attendance summaries and reports across classes.",
        riskLevel: "low",
          usedIn: ["Attendance Reports"],
  },
  "attendance.calendar.manage": {
    label: "Manage attendance calendar",
      description: "Set holidays and working-day overrides used for attendance tracking.",
        riskLevel: "medium",
          usedIn: ["Attendance Calendar"],
  },

  // ── FEES ──────────────────────────────────────────────────────────────
  "fees.structures.manage": {
    label: "Manage fee structures",
      description: "Create and edit the fee structures charged to students.",
        riskLevel: "high",
          usedIn: ["Fee Structures"],
  },
  "fees.payments.record": {
    label: "Record fee payments",
      description: "Record a payment received from a student against their fees.",
        riskLevel: "high",
          usedIn: ["Fee Payments", "Bulk Fee Assignment"],
  },
  "fees.report": {
    label: "View fee reports",
      description: "See school-wide fee collection and outstanding-balance reports.",
        riskLevel: "medium",
          usedIn: ["Fee Reports"],
  },
  "fees.ledger.view": {
    label: "View student fee ledgers",
      description: "See any individual student's fee payment history.",
        riskLevel: "medium",
          usedIn: ["Student Fee Ledger"],
  },

  // ── ASSIGNMENTS ───────────────────────────────────────────────────────
  "assignments.create": {
    label: "Create assignments",
      description: "Create a new assignment for a class-section.",
        riskLevel: "low",
          usedIn: ["Assignments"],
  },
  "assignments.edit": {
    label: "Edit assignments",
      description: "Edit an existing assignment's details or due date.",
        riskLevel: "low",
          usedIn: ["Assignments"],
  },
  "assignments.delete": {
    label: "Delete assignments",
      description: "Permanently delete an assignment and its student submissions.",
        riskLevel: "high",
          usedIn: ["Assignments"],
  },
  "assignments.submissions.view": {
    label: "View submissions",
      description: "See student submissions for an assignment.",
        riskLevel: "low",
          usedIn: ["Assignment Submissions"],
  },
  "assignments.grade": {
    label: "Grade assignments",
      description: "Enter grades or feedback on student assignment submissions.",
        riskLevel: "low",
          usedIn: ["Assignment Grading"],
  },

  // ── EXAMS ─────────────────────────────────────────────────────────────
  "exams.create": {
    label: "Create exams",
      description: "Create a new exam for a class-section.",
        riskLevel: "medium",
          usedIn: ["Exams"],
  },
  "exams.edit": {
    label: "Edit exams",
      description: "Edit an existing exam's details, schedule, or subjects.",
        riskLevel: "medium",
          usedIn: ["Exams"],
  },
  "exams.delete": {
    label: "Delete exams",
      description: "Permanently delete an exam and its recorded marks.",
        riskLevel: "high",
          usedIn: ["Exams"],
  },
  "exams.marks.enter": {
    label: "Enter exam marks",
      description: "Enter or update student marks for an exam.",
        riskLevel: "medium",
          usedIn: ["Exam Marks Entry"],
  },
  "exams.admit-card": {
    label: "Generate admit cards",
      description: "Generate exam admit cards for students.",
        riskLevel: "low",
          usedIn: ["Admit Cards"],
  },
  "exams.report-card": {
    label: "Generate report cards",
      description: "Generate student report cards from exam results.",
        riskLevel: "low",
          usedIn: ["Report Cards"],
  },
  "exams.admit-card.publish": {
    label: "Publish admit cards",
      description: "Make generated admit cards visible for students and parents to download.",
        riskLevel: "medium",
          usedIn: ["Admit Cards — Publish"],
  },
  "exams.report-card.publish": {
    label: "Publish report cards",
      description: "Make finalized report cards visible for students and parents to download.",
        riskLevel: "high",
          usedIn: ["Report Cards — Publish"],
  },
  "exams.templates.manage": {
    label: "Manage exam templates",
      description: "Configure the layout used for admit cards and report cards.",
        riskLevel: "medium",
          usedIn: ["Exam Templates"],
  },

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────
  "notifications.send": {
    label: "Send notifications",
      description: "Send notifications to students, parents, or staff.",
        riskLevel: "medium",
          usedIn: ["Send Notifications"],
  },
  "notifications.view": {
    label: "View sent notifications",
      description: "See the history of notifications sent by the school.",
        riskLevel: "low",
          usedIn: ["Notifications History"],
  },

  // ── SETTINGS ──────────────────────────────────────────────────────────
  "settings.manage": {
    label: "Manage school settings",
      description: "Change core school settings such as name, contact details, and branding.",
        riskLevel: "high",
          usedIn: ["School Settings"],
  },
  "settings.theme.manage": {
    label: "Manage school theme",
      description: "Change the school's visual theme and appearance.",
        riskLevel: "low",
          usedIn: ["Theme Settings"],
  },

  // ── BILLING ───────────────────────────────────────────────────────────
  "billing.view": {
    label: "View billing",
      description: "See the school's subscription status, payment history, and access expiry.",
        riskLevel: "medium",
          usedIn: ["Billing"],
  },
  "billing.manage": {
    label: "Manage billing",
      description: "Make payments, manage autopay, and purchase messaging bundles on the school's account.",
        riskLevel: "critical",
          usedIn: ["Billing — Payments & Bundles"],
  },

  // ── STUDENTS ──────────────────────────────────────────────────────────
  "students.list": {
    label: "View students",
      description: "See the list of students enrolled at the school.",
        riskLevel: "low",
          usedIn: ["Students List"],
  },
  "students.profile.manage": {
    label: "Manage student profiles",
      description: "Edit a student's personal, academic, and UDISE+ profile details.",
        riskLevel: "medium",
          usedIn: ["Student Profile", "User Creation Hub"],
  },
  "students.bulk-upload": {
    label: "Bulk upload students",
      description: "Add many students at once from an Excel or CSV file.",
        riskLevel: "medium",
          usedIn: ["Bulk Student Upload"],
  },

  // ── ID CARDS ──────────────────────────────────────────────────────────
  "id-cards.generate": {
    label: "Generate ID cards",
      description: "Generate ID cards for one or more students or staff.",
        riskLevel: "low",
          usedIn: ["ID Card Generation"],
  },
  "id-cards.view": {
    label: "View ID cards",
      description: "See the list of issued ID cards.",
        riskLevel: "low",
          usedIn: ["ID Cards"],
  },
  "id-cards.revoke": {
    label: "Revoke ID cards",
      description: "Revoke an issued ID card and mark it invalid.",
        riskLevel: "medium",
          usedIn: ["ID Cards"],
  },
  "id-cards.print": {
    label: "Export ID cards",
      description: "Download or print generated ID cards as PDF.",
        riskLevel: "low",
          usedIn: ["ID Card Export"],
  },
  "id-cards.delete": {
    label: "Delete ID cards",
      description: "Permanently delete an ID card record.",
        riskLevel: "high",
          usedIn: ["ID Cards"],
  },
  "id-cards.templates.manage": {
    label: "Manage ID card templates",
      description: "Create and edit the layout used for ID cards.",
        riskLevel: "medium",
          usedIn: ["ID Card Templates"],
  },

  // ── FEED ──────────────────────────────────────────────────────────────
  "feed.post.create": {
    label: "Create feed posts",
      description: "Create a new post on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },
  "feed.post.manage": {
    label: "Manage feed posts",
      description: "Edit or delete any post on the school feed, including posts by others.",
        riskLevel: "medium",
          usedIn: ["School Feed — Moderation"],
  },
  "feed.view": {
    label: "View feed",
      description: "See posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },
  "feed.react": {
    label: "React to feed posts",
      description: "Like or react to posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },

  // ── TEACHERS / PARENTS / CONTACT ──────────────────────────────────────
  "teachers.profile.manage": {
    label: "Manage teacher profiles",
      description: "Edit a teacher's qualification, experience, and specialization details.",
        riskLevel: "medium",
          usedIn: ["Teacher Profile"],
  },
  "parents.manage": {
    label: "Manage parent links",
      description: "Link or unlink parent accounts to their children.",
        riskLevel: "medium",
          usedIn: ["Parent-Student Manager"],
  },
  "contact.submit": {
    label: "Submit contact requests",
      description: "Submit support or contact requests on behalf of the school.",
        riskLevel: "low",
          usedIn: ["Contact / Support"],
  },

  // ── LIBRARY / TRANSPORT ───────────────────────────────────────────────
  "library.issue": {
    label: "Issue library books",
      description: "Issue a library book to a student or staff member.",
        riskLevel: "low",
          usedIn: ["Library"],
  },
  "library.return": {
    label: "Return library books",
      description: "Record the return of a library book.",
        riskLevel: "low",
          usedIn: ["Library"],
  },
  "transport.manage": {
    label: "Manage transport",
      description: "Manage transport routes and vehicle assignments.",
        riskLevel: "medium",
          usedIn: ["Transport"],
  },

  // ══════════════════════════════════════════════════════════════════════
  // STUDENT PORTAL
  // ══════════════════════════════════════════════════════════════════════
  "dashboard.student.view": {
    label: "View student dashboard",
      description: "See their own dashboard with attendance, fees, and assignment summaries.",
        riskLevel: "low",
          usedIn: ["Student Dashboard"],
  },
  "students.view.own": {
    label: "View own profile",
      description: "See their own student profile details.",
        riskLevel: "low",
          usedIn: ["Student Profile"],
  },
  "attendance.student.view": {
    label: "View own attendance",
      description: "See their own attendance record.",
        riskLevel: "low",
          usedIn: ["Student Attendance"],
  },
  "fees.student.view": {
    label: "View own fees",
      description: "See their own fee ledger and payment history.",
        riskLevel: "low",
          usedIn: ["Student Fees"],
  },
  "assignments.student.view": {
    label: "View own assignments",
      description: "See assignments given to their class.",
        riskLevel: "low",
          usedIn: ["Student Assignments"],
  },
  "assignments.student.submit": {
    label: "Submit assignments",
      description: "Mark their own assignment as submitted.",
        riskLevel: "low",
          usedIn: ["Student Assignments"],
  },
  "exams.student.view": {
    label: "View own marks",
      description: "See their own exam marks and results.",
        riskLevel: "low",
          usedIn: ["Student Marks"],
  },
  "exams.student.admit-card": {
    label: "Download own admit card",
      description: "Download their own exam admit card.",
        riskLevel: "low",
          usedIn: ["Student Admit Card"],
  },
  "exams.student.report-card": {
    label: "Download own report card",
      description: "Download their own report card.",
        riskLevel: "low",
          usedIn: ["Student Report Card"],
  },
  "notifications.student.view": {
    label: "View notifications",
      description: "See notifications sent to them.",
        riskLevel: "low",
          usedIn: ["Student Notifications"],
  },
  "feed.student.view": {
    label: "View feed",
      description: "See posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },
  "feed.student.react": {
    label: "React to feed posts",
      description: "Like or react to posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },

  // ══════════════════════════════════════════════════════════════════════
  // PARENT PORTAL
  // ══════════════════════════════════════════════════════════════════════
  "dashboard.parent.view": {
    label: "View parent dashboard",
      description: "See their dashboard with their child's attendance, fees, and assignment summaries.",
        riskLevel: "low",
          usedIn: ["Parent Dashboard"],
  },
  "attendance.parent.view": {
    label: "View child's attendance",
      description: "See their child's attendance record.",
        riskLevel: "low",
          usedIn: ["Child Attendance"],
  },
  "fees.parent.view": {
    label: "View child's fees",
      description: "See their child's fee summary and payment history.",
        riskLevel: "low",
          usedIn: ["Child Fees"],
  },
  "assignments.parent.view": {
    label: "View child's assignments",
      description: "See assignments given to their child's class.",
        riskLevel: "low",
          usedIn: ["Child Assignments"],
  },
  "exams.parent.view": {
    label: "View child's marks",
      description: "See their child's exam marks and results.",
        riskLevel: "low",
          usedIn: ["Child Marks"],
  },
  "exams.parent.admit-card": {
    label: "Download child's admit card",
      description: "Download their child's exam admit card.",
        riskLevel: "low",
          usedIn: ["Child Admit Card"],
  },
  "exams.parent.report-card": {
    label: "Download child's report card",
      description: "Download their child's report card.",
        riskLevel: "low",
          usedIn: ["Child Report Card"],
  },
  "notifications.parent.view": {
    label: "View notifications",
      description: "See notifications sent to them.",
        riskLevel: "low",
          usedIn: ["Parent Notifications"],
  },
  "feed.parent.view": {
    label: "View feed",
      description: "See posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },
  "feed.parent.react": {
    label: "React to feed posts",
      description: "Like or react to posts on the school feed.",
        riskLevel: "low",
          usedIn: ["School Feed"],
  },
};

/**
 * Merges a permission's static metadata onto a DB row's display fields.
 * Never persists — call this in any route/service that returns permission
 * objects for display, right before sending the response.
 *
 * Falls back to a mechanically-generated label if a slug somehow reaches
 * here without a metadata entry (shouldn't happen — the Record type above
 * makes that a compile error for known slugs — but this guards against
 * stale/legacy rows in an already-seeded school's DB).
 */
export function getPermissionMeta(slug: string): PermissionMeta {
  const meta = (PERMISSION_METADATA as Record<string, PermissionMeta>)[slug];
  if (meta) return meta;

  console.warn(
    `⚠️ No PERMISSION_METADATA entry for slug "${slug}" — using generated fallback copy. Add an entry in school-permissions.ts.`
  );
  return {
    label: slug
      .split(".")
      .map((part) =>
        part
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")
      )
      .join(" "),
    description: `No description written yet for "${slug}".`,
    riskLevel: "low",
    usedIn: [],
  };
}