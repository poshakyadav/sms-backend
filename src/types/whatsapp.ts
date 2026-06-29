/**
 * src/types/whatsapp.ts
 *
 * Shared domain types for the entire WhatsApp Cloud API integration.
 *
 * ── WHO USES THIS FILE ────────────────────────────────────────────────────────
 *
 *   services/whatsapp/whatsapp-service.ts          ← WhatsappTemplateComponent
 *   db/schemas/school/whatsapp-messages.ts         ← *Value enum types for columns
 *   modules/school/whatsapp/send-service.ts        ← PLATFORM_TEMPLATES, service I/O shapes
 *   modules/school/whatsapp/routes.ts              ← PLATFORM_TEMPLATES (for definitions endpoint)
 *   modules/webhooks/whatsapp/handler.ts           ← Meta webhook payload types
 *   utils/whatsapp-credits.ts                      ← no direct import (uses own types)
 *
 * ── ARCHITECTURE REMINDER ────────────────────────────────────────────────────
 *
 *   OUTBOUND (school → parent/student)
 *     School action → credit check → deduct → call Meta Graph API
 *     → Meta delivers → webhook status events arrive → update row status
 *
 *   INBOUND (parent/student → our WhatsApp number)
 *     Parent sends a message → Meta webhook POST → we log it
 *     → NO credit consumed (inbound is always free)
 *
 *   CREDIT MODEL (prepaid, optimistic deduction)
 *     Credits are deducted BEFORE calling Meta.
 *     Prevents concurrent bulk sends from overdrawing the same balance.
 *     On hard Meta failure → credit stays deducted (API slot was consumed).
 *     On transient failure → row marked FAILED; no automatic refund.
 *
 * ── PRICING CONTEXT (India, 2025-2026) ───────────────────────────────────────
 *
 *   UTILITY template  → ~₹0.16/message  (our primary type — attendance, fees, results)
 *   MARKETING template → ~₹0.88/message (announcements — use sparingly)
 *   AUTHENTICATION     → ~₹0.13/message (OTP — future)
 *   INBOUND (service)  → ₹0 within 24-hour customer service window
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — STATUS / ENUM CONSTANTS
// These mirror either Meta's own vocabulary or our internal state machine.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a single outbound message row in whatsapp_messages.
 *
 *   QUEUED        → credit deducted, DB row inserted, Meta API not yet called
 *   SENT          → Meta accepted, wamid assigned (single grey tick in WhatsApp)
 *   DELIVERED     → Meta confirmed device delivery (double grey tick)
 *   READ          → recipient opened the message (double blue tick)
 *   FAILED        → Meta permanently rejected (invalid number, spam block, etc.)
 *   TEMPLATE_ERROR → template not approved / wrong variable count at send time
 *
 * State transitions (normal path):   QUEUED → SENT → DELIVERED → READ
 * Failure path:                       QUEUED → FAILED  or  QUEUED → TEMPLATE_ERROR
 *
 * IMPORTANT: Status must only advance — never downgrade.
 * A DELIVERED message must never go back to SENT.
 * The webhook handler enforces this with a statusOrder guard.
 */
export const WhatsappMessageStatus = {
  QUEUED: "QUEUED",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  FAILED: "FAILED",
  TEMPLATE_ERROR: "TEMPLATE_ERROR",
} as const;
export type WhatsappMessageStatusValue =
  (typeof WhatsappMessageStatus)[keyof typeof WhatsappMessageStatus];

/**
 * WhatsApp template category — mirrors Meta's API values exactly.
 * Used on both the local whatsapp_templates cache rows and on
 * whatsapp_messages rows (stored at send time so history is self-contained).
 *
 * UTILITY       → Transactional messages user expects (attendance, fees, results)
 * MARKETING     → Promotional / announcement messages
 * AUTHENTICATION → OTP / login verification (future use)
 */
export const WhatsappTemplateCategory = {
  UTILITY: "UTILITY",
  MARKETING: "MARKETING",
  AUTHENTICATION: "AUTHENTICATION",
} as const;
export type WhatsappTemplateCategoryValue =
  (typeof WhatsappTemplateCategory)[keyof typeof WhatsappTemplateCategory];

/**
 * Approval status of a template in Meta's system.
 * Mirrors Meta's values — stored in whatsapp_templates.status.
 *
 * PENDING   → submitted for review, not yet usable
 * APPROVED  → ready to send — only APPROVED templates can be sent
 * REJECTED  → Meta rejected; cannot be sent; resubmit with changes
 * PAUSED    → Meta paused for quality issues; auto-resumes or requires action
 * DISABLED  → permanently disabled by Meta
 */
export const WhatsappTemplateStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
} as const;
export type WhatsappTemplateStatusValue =
  (typeof WhatsappTemplateStatus)[keyof typeof WhatsappTemplateStatus];

/**
 * Who the outbound message is addressed to.
 * Stored on whatsapp_messages.recipientType.
 *
 * PARENT   → linked to school_users via studentParentsSchema
 * STUDENT  → directly linked school_users row (student portal user)
 * STAFF    → school staff member
 * EXTERNAL → raw phone number not linked to any school_users row
 */
export const WhatsappRecipientType = {
  PARENT: "PARENT",
  STUDENT: "STUDENT",
  STAFF: "STAFF",
  EXTERNAL: "EXTERNAL",
} as const;
export type WhatsappRecipientTypeValue =
  (typeof WhatsappRecipientType)[keyof typeof WhatsappRecipientType];

/**
 * Lifecycle status of a whatsapp_bulk_sends row.
 *
 * DRAFT     → created by initiateBulkSend(), credits reserved, not yet started
 * SENDING   → executeBulkSend() is actively dispatching messages
 * COMPLETED → all messages sent successfully (failedCount = 0)
 * PARTIAL   → completed but some messages failed (sentCount > 0 AND failedCount > 0)
 * FAILED    → all messages failed (sentCount = 0)
 * CANCELLED → school cancelled before starting (refund logic not implemented yet)
 */
export const BulkSendStatus = {
  DRAFT: "DRAFT",
  SENDING: "SENDING",
  COMPLETED: "COMPLETED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type BulkSendStatusValue =
  (typeof BulkSendStatus)[keyof typeof BulkSendStatus];

/**
 * Who a bulk send is targeting.
 * Determines which DB query resolveRecipients() uses.
 *
 * ALL_PARENTS            → all active STUDENT_PARENT users in the school
 * ALL_STUDENTS           → all active STUDENT users
 * ALL_STAFF              → all active users who are neither STUDENT nor STUDENT_PARENT
 * CLASS_SECTION_PARENTS  → parents of students enrolled in a specific classSectionId
 * CLASS_SECTION_STUDENTS → students enrolled in a specific classSectionId
 * CUSTOM_USER_LIST       → arbitrary list of school_users.id values
 * CUSTOM_PHONE_LIST      → raw E.164 phone numbers (not linked to any user)
 */
export const BulkTargetType = {
  ALL_PARENTS: "ALL_PARENTS",
  ALL_STUDENTS: "ALL_STUDENTS",
  ALL_STAFF: "ALL_STAFF",
  CLASS_SECTION_PARENTS: "CLASS_SECTION_PARENTS",
  CLASS_SECTION_STUDENTS: "CLASS_SECTION_STUDENTS",
  CUSTOM_USER_LIST: "CUSTOM_USER_LIST",
  CUSTOM_PHONE_LIST: "CUSTOM_PHONE_LIST",
} as const;
export type BulkTargetTypeValue =
  (typeof BulkTargetType)[keyof typeof BulkTargetType];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — PLATFORM TEMPLATES
//
// These are the 14 Meta-approved UTILITY templates registered in the WABA.
// Template names match exactly what is registered in Meta Business Manager.
// The `variables` array maps human-readable names to {{N}} positions:
//   variables[0] → {{1}}, variables[1] → {{2}}, and so on.
//
// All 14 templates are UTILITY category (lower Meta cost ~₹0.16/msg).
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORM_TEMPLATES = {
  // ── 1. Monthly fee due reminder ──────────────────────────────────────────
  // Template name: school_monthly_fee_due
  // Triggered: manually from fees module or scheduled reminder.
  MONTHLY_FEE_DUE: {
    name: "school_monthly_fee_due",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent of {{1}},\n\nThis is a reminder for the pending fee at {{2}}.\n\nStudent: {{3}}\nClass: {{4}}\nRoll No: {{5}}\nMonth: {{6}}\n\nFEE BREAKDOWN\n____________________\n{{7}}\n\nTotal Due:     ₹{{8}}\nDue Date:      {{9}}\n____________________\n\nKindly pay before the due date to avoid a late fee.\n\nFor queries, contact: {{10}}\n{{11}}\n\nThanks!",
    variables: [
      "parent_name",        // {{1}}  e.g. "Rahul Sharma"
      "school_name",        // {{2}}  e.g. "Delhi Public School"
      "student_name",       // {{3}}  e.g. "Rahul Sharma"
      "class_section",      // {{4}}  e.g. "Class 9 - A"
      "roll_number",        // {{5}}  e.g. "42"
      "month",              // {{6}}  e.g. "June 2026"
      "fee_breakdown",      // {{7}}  e.g. "Tuition Fee: ₹3500 | Library Fee: ₹200 | Sports Fee: ₹300"
      "total_due",          // {{8}}  e.g. "4000"
      "due_date",           // {{9}}  e.g. "10 Jun 2026"
      "contact",            // {{10}} e.g. "9876543210"
      "school_name_footer", // {{11}} e.g. "Delhi Public School"
    ] as const,
    description: "Monthly fee due reminder sent to parent with full fee breakdown",
  },

  // ── 2. Fee payment confirmed ──────────────────────────────────────────────
  // Template name: school_fee_payment_confirmed
  // Triggered: automatically after fee_payments row is inserted.
  FEE_PAYMENT_CONFIRMED: {
    name: "school_fee_payment_confirmed",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent of {{1}},\n\nPayment received successfully at {{2}}.\n\nPAYMENT RECEIPT\n__________________________\nReceipt No:    {{3}}\nDate:          {{4}}\nPayment Mode:  {{5}}\n__________________________\n\nStudent:       {{6}}\nClass:         {{7}}\nAcademic Year: {{8}}\n\nFEES PAID\n__________________________\n{{9}}\n\nAmount Paid:   Rs. {{10}}\n__________________________\n\nFEE SUMMARY\n__________________________\nTotal Annual Fee:  Rs. {{11}}\nTotal Paid (YTD):  Rs. {{12}}\nConcession Given:  Rs. {{13}}\nBalance Remaining: Rs. {{14}}\n__________________________\n\n{{15}} Accounts Team\nContact: {{16}}\n\nThank you for your timely payment.",
    variables: [
      "parent_name",         // {{1}}  e.g. "Priya Verma"
      "school_name",         // {{2}}  e.g. "Sunrise Academy"
      "receipt_number",      // {{3}}  e.g. "RCP-2026-00847"
      "payment_date",        // {{4}}  e.g. "18 Jun 2026"
      "payment_mode",        // {{5}}  e.g. "Bank Transfer"
      "student_name",        // {{6}}  e.g. "Priya Verma"
      "class_section",       // {{7}}  e.g. "Class 10 - B"
      "academic_year",       // {{8}}  e.g. "2025-2026"
      "fees_paid_breakdown", // {{9}}  e.g. "Tuition Fee (June): Rs.3500 | Transport Fee: Rs.800"
      "amount_paid",         // {{10}} e.g. "4300"
      "total_annual_fee",    // {{11}} e.g. "52000"
      "total_paid_ytd",      // {{12}} e.g. "28600"
      "concession_given",    // {{13}} e.g. "2000"
      "balance_remaining",   // {{14}} e.g. "21400"
      "school_name_team",    // {{15}} e.g. "Sunrise Academy"
      "contact",             // {{16}} e.g. "9876543210"
    ] as const,
    description: "Fee payment confirmation receipt with full summary sent to parent",
  },

  // ── 3. Fee overdue alert ──────────────────────────────────────────────────
  // Template name: school_fee_overdue_alert
  // Triggered: manually or scheduled for past-due fees.
  FEE_OVERDUE_ALERT: {
    name: "school_fee_overdue_alert",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Overdue fee notice from {{1}}.\n\nDear Parent, the fee for {{2}} is now overdue.\n\nStudent: {{3}}\nClass: {{4}}\nRoll No: {{5}}\n\nOVERDUE DETAILS\n{{6}}\n\nAmount Overdue: Rs. {{7}}\nWas Due On: {{8}}\nDays Overdue: {{9}} days\n\nPlease clear the outstanding balance immediately to avoid disruption to your child's academics. \n\nFor payment or queries, contact: {{10}}.\n\nThis is an automated reminder.",
    variables: [
      "school_name",       // {{1}}  e.g. "Greenfield School"
      "student_name",      // {{2}}  e.g. "Amit Kumar"
      "student_name_2",    // {{3}}  e.g. "Amit Kumar"  (repeated in template)
      "class_section",     // {{4}}  e.g. "Class 8 - C"
      "roll_number",       // {{5}}  e.g. "17"
      "overdue_breakdown", // {{6}}  e.g. "Tuition Fee (May): Rs.3500 | Library Fee: Rs.200"
      "amount_overdue",    // {{7}}  e.g. "3700"
      "was_due_on",        // {{8}}  e.g. "10 May 2026"
      "days_overdue",      // {{9}}  e.g. "14"
      "contact",           // {{10}} e.g. "9876543210"
    ] as const,
    description: "Overdue fee alert with days overdue count sent to parent",
  },

  // ── 4. Student fee assigned ───────────────────────────────────────────────
  // Template name: school_student_fee_assigned
  // Triggered: when a new per-student fee assignment is created.
  STUDENT_FEE_ASSIGNED: {
    name: "school_student_fee_assigned",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Fee assignment notice from {{1}}.\n\nDear Parent, a new fee has been assigned to {{2}}.\n\nStudent: {{3}}\nClass: {{4}}\n\nFEE DETAILS\nFee Type: {{5}}\nDescription: {{6}}\nAmount: Rs. {{7}}\nApplicable Period: {{8}}\nDue Date: {{9}}\nMandatory: {{10}}\n\nPlease ensure timely payment. For queries, contact: {{11}}.\n\nThank you.",
    variables: [
      "school_name",        // {{1}}  e.g. "Sunrise Academy"
      "student_name",       // {{2}}  e.g. "Sneha Gupta"
      "student_name_2",     // {{3}}  e.g. "Sneha Gupta"  (repeated in template)
      "class_section",      // {{4}}  e.g. "Class 6 - A"
      "fee_type",           // {{5}}  e.g. "Transport Fee"
      "fee_description",    // {{6}}  e.g. "Zone 3 - Kidwai Nagar route, approx 8km"
      "amount",             // {{7}}  e.g. "800 per month"
      "applicable_period",  // {{8}}  e.g. "June 2026 to June 2027"
      "due_date",           // {{9}}  e.g. "10th of every month"
      "is_mandatory",       // {{10}} e.g. "Yes"
      "contact",            // {{11}} e.g. "9876543210"
    ] as const,
    description: "New fee assignment notice with fee details sent to parent",
  },

  // ── 5. Exam schedule published ────────────────────────────────────────────
  // Template name: school_exam_schedule_published
  // Triggered: when exam schedule is published by school.
  EXAM_SCHEDULE_PUBLISHED: {
    name: "school_exam_schedule_published",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Exam schedule published by {{1}}.\n\nDear Parent, the examination schedule for {{2}} has been published.\n\nStudent: {{3}}\nClass: {{4}}\nExam Name: {{5}}\nExam Type: {{6}}\n\nSUBJECT SCHEDULE\n{{7}}\n\nExam Period: {{8}} to {{9}}.\n\nAdmit card will be shared separately once published. For queries, contact: {{10}}.\n\nThank you.",
    variables: [
      "school_name",       // {{1}}  e.g. "Delhi Public School"
      "student_name",      // {{2}}  e.g. "Ravi Sharma"
      "student_name_2",    // {{3}}  e.g. "Ravi Sharma"  (repeated in template)
      "class_section",     // {{4}}  e.g. "Class 10 - A"
      "exam_name",         // {{5}}  e.g. "Mid-Term Exam 2026"
      "exam_type",         // {{6}}  e.g. "Mid Term"
      "subject_schedule",  // {{7}}  e.g. "English | 20 Jun | 9:00-11:00 | 80 marks || Mathematics | 22 Jun | 9:00-11:00 | 80 marks"
      "exam_start_date",   // {{8}}  e.g. "20 Jun 2026"
      "exam_end_date",     // {{9}}  e.g. "28 Jun 2026"
      "contact",           // {{10}} e.g. "9876543210"
    ] as const,
    description: "Exam schedule with full subject timetable published notification to parent",
  },

  // ── 6. Admit card published ───────────────────────────────────────────────
  // Template name: school_admit_card_published
  // Triggered: when admitCardPublished flag is set to true on an exam.
  ADMIT_CARD_PUBLISHED: {
    name: "school_admit_card_published",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Admit card published by {{1}}.\n\nDear Parent, the Admit Card for {{2}} is now available for download.\n\nStudent: {{3}}\nClass: {{4}}\nRoll No: {{5}}\nExam: {{6}}\n\nPlease download the Admit Card from the school portal before the exam date.\n\nIMPORTANT INSTRUCTIONS\nCarry the printed Admit Card on all exam days. Report at {{7}} on each exam day. Bring your own stationery. Mobile phones are NOT allowed in the exam hall.\n\nFirst Exam: {{8}} at {{9}}.\nVenue: {{10}}.\n\nPortal Login: {{11}}.\n\nThank you.",
    variables: [
      "school_name",     // {{1}}  e.g. "Sunrise Academy"
      "exam_name",       // {{2}}  e.g. "Final Exam 2026"
      "student_name",    // {{3}}  e.g. "Neha Singh"
      "class_section",   // {{4}}  e.g. "Class 5 - A"
      "roll_number",     // {{5}}  e.g. "35"
      "exam_name_2",     // {{6}}  e.g. "Final Exam 2026"  (repeated in template)
      "report_time",     // {{7}}  e.g. "8:45 AM"
      "first_exam_date", // {{8}}  e.g. "15 Jun 2026"
      "first_exam_time", // {{9}}  e.g. "9:00 AM"
      "venue",           // {{10}} e.g. "Main Examination Hall, Block A"
      "portal_url",      // {{11}} e.g. "app.sunriseacademy.com"
    ] as const,
    description: "Admit card availability notification with exam instructions to parent",
  },

  // ── 7. Result published ───────────────────────────────────────────────────
  // Template name: school_result_published
  // Triggered: when reportCardPublished flag is set to true on an exam.
  RESULT_PUBLISHED: {
    name: "school_result_published",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Result published by {{1}}.\n\nDear Parent, the result for {{2}} has been published.\n\nStudent: {{3}}\nClass: {{4}}\nRoll No: {{5}}\nExam: {{6}}\nAcademic Year: {{7}}\n\nRESULT SUMMARY\n{{8}}\n\nTotal Marks: {{9}} out of {{10}}.\nPercentage: {{11}}%\nOverall Grade: {{12}}\nResult Status: {{13}}\n\nThe detailed Report Card is available on the school portal. Portal Login: {{14}}.\n\nThank you.",
    variables: [
      "school_name",       // {{1}}  e.g. "Delhi Public School"
      "exam_name",         // {{2}}  e.g. "Mid-Term Exam 2026"
      "student_name",      // {{3}}  e.g. "Vikram Yadav"
      "class_section",     // {{4}}  e.g. "Class 9 - B"
      "roll_number",       // {{5}}  e.g. "28"
      "exam_name_2",       // {{6}}  e.g. "Mid-Term Exam 2026"  (repeated)
      "academic_year",     // {{7}}  e.g. "2025-2026"
      "result_summary",    // {{8}}  e.g. "English: 72/80 (A) | Mathematics: 68/80 (B+) | Science: 75/80 (A+)"
      "total_marks",       // {{9}}  e.g. "285"
      "total_out_of",      // {{10}} e.g. "320"
      "percentage",        // {{11}} e.g. "89.06"
      "overall_grade",     // {{12}} e.g. "A+"
      "result_status",     // {{13}} e.g. "PASS"
      "portal_url",        // {{14}} e.g. "app.dps.com"
    ] as const,
    description: "Exam result with full subject-wise marks and grade summary to parent",
  },

  // ── 8. Student absent today ───────────────────────────────────────────────
  // Template name: school_student_absent_today
  // Triggered: automatically when attendance is marked absent.
  STUDENT_ABSENT_TODAY: {
    name: "school_student_absent_today",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Attendance alert from {{1}}.\n\nDear Parent, {{2}} was marked absent today.\n\nStudent: {{3}}\nClass: {{4}}\nDate: {{5}}\nStatus: {{6}}\nNote: {{7}}\n\nIf this absence is unexpected, please contact the school immediately. To report a planned absence in advance, call: {{8}}.\n\nThank you.",
    variables: [
      "school_name",   // {{1}}  e.g. "Greenfield School"
      "student_name",  // {{2}}  e.g. "Pooja Mishra"
      "student_name_2",// {{3}}  e.g. "Pooja Mishra"  (repeated)
      "class_section", // {{4}}  e.g. "Class 7 - A"
      "date",          // {{5}}  e.g. "23 Jun 2026"
      "status",        // {{6}}  e.g. "Absent"
      "note",          // {{7}}  e.g. "No prior intimation received"
      "contact",       // {{8}}  e.g. "9876543210"
    ] as const,
    description: "Absent today alert with status and note sent to parent",
  },

  // ── 9. Low attendance warning ─────────────────────────────────────────────
  // Template name: school_low_attendance_warning
  // Triggered: when student attendance drops below required threshold.
  LOW_ATTENDANCE_WARNING: {
    name: "school_low_attendance_warning",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent of {{1}}, Urgent attendance notice from {{2}}.\n\nStudent: {{3}} | Class: {{4}} | Year: {{5}}\n\nATTENDANCE REPORT\n- Working Days: {{6}}\n- Present: {{7}}\n- Absent: {{8}}\n- Leave/Holiday: {{9}}\n- Attendance: {{10}}%\n- Required: {{11}}%\n- Shortfall: {{12}}%\n\nYour child's attendance is below the minimum required. This may affect exam eligibility. Please ensure regular attendance.\n\nFor queries or leave applications, contact: {{13}} | {{14}}\nThanks!",
    variables: [
      "parent_name",     // {{1}}  e.g. "Rohit Tiwari"
      "school_name",     // {{2}}  e.g. "Sunrise Academy"
      "student_name",    // {{3}}  e.g. "Rohit Tiwari"
      "class_section",   // {{4}}  e.g. "Class 6 - A"
      "academic_year",   // {{5}}  e.g. "2025-2026"
      "working_days",    // {{6}}  e.g. "120"
      "present_days",    // {{7}}  e.g. "82"
      "absent_days",     // {{8}}  e.g. "24"
      "leave_days",      // {{9}}  e.g. "14"
      "attendance_pct",  // {{10}} e.g. "68.33"
      "required_pct",    // {{11}} e.g. "75"
      "shortfall_pct",   // {{12}} e.g. "6.67"
      "contact",         // {{13}} e.g. "9876543210"
      "school_name_2",   // {{14}} e.g. "Sunrise Academy"  (repeated)
    ] as const,
    description: "Low attendance warning with full attendance report to parent",
  },

  // ── 10. Admission confirmed ───────────────────────────────────────────────
  // Template name: school_admission_confirmed
  // Triggered: when a new student admission is confirmed.
  ADMISSION_CONFIRMED: {
    name: "school_admission_confirmed",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear {{1}},\n\nWe are delighted to confirm the admission of {{2}} at {{3}}.\n\nADMISSION DETAILS\nStudent: {{4}}\nAdmission No: {{5}}\nClass: {{6}}\nYear: {{7}}\nDate: {{8}}\n\nNEXT STEPS\n- Report to school as per the schedule provided by administration\n- Bring original documents for verification\n\nPortal credentials will be shared separately.\nWelcome to the {{9}} family!\n\nQueries: {{10}}\n{{11}} Admissions Team\n\nThanks!",
    variables: [
      "parent_name",     // {{1}}  e.g. "Mr. Suresh Kumar"
      "student_name",    // {{2}}  e.g. "Ananya Kumari"
      "school_name",     // {{3}}  e.g. "Sunrise Academy"
      "student_name_2",  // {{4}}  e.g. "Ananya Kumari"  (repeated)
      "admission_number",// {{5}}  e.g. "ADM-2026-00312"
      "class_section",   // {{6}}  e.g. "Class 1 - A"
      "academic_year",   // {{7}}  e.g. "2026-2027"
      "admission_date",  // {{8}}  e.g. "01 Apr 2026"
      "school_name_2",   // {{9}}  e.g. "Sunrise Academy"  (repeated)
      "contact",         // {{10}} e.g. "9876543210"
      "school_name_3",   // {{11}} e.g. "Sunrise Academy"  (repeated)
    ] as const,
    description: "Admission confirmation with details and next steps to parent",
  },

  // ── 11. Assignment due reminder ───────────────────────────────────────────
  // Template name: school_assignment_due_reminder
  // Triggered: manually or 1 day before assignment due date.
  ASSIGNMENT_DUE_REMINDER: {
    name: "school_assignment_due_reminder",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent of {{1}},\n\nA reminder about a pending assignment from {{2}}.\n\nStudent:     {{3}}\nClass:       {{4}}\nSubject:     {{5}}\nTeacher:     {{6}}\n\nASSIGNMENT DETAILS\n__________________________\nTitle:       {{7}}\nType:        {{8}}\nDue Date:    {{9}}\nMax Marks:   {{10}}\nMandatory:   {{11}}\n__________________________\n\nDescription:\n{{12}}\n\nPlease ensure your child completes and submits the assignment on time.\n\n{{13}}\n\nThanks!",
    variables: [
      "student_name",      // {{1}}  e.g. "Karan Mehta"
      "school_name",       // {{2}}  e.g. "Delhi Public School"
      "student_name_2",    // {{3}}  e.g. "Karan Mehta"  (repeated)
      "class_section",     // {{4}}  e.g. "Class 8 - B"
      "subject",           // {{5}}  e.g. "Mathematics"
      "teacher_name",      // {{6}}  e.g. "Mrs. Sunita Sharma"
      "assignment_title",  // {{7}}  e.g. "Chapter 5 - Linear Equations Practice Sheet"
      "assignment_type",   // {{8}}  e.g. "Home Work"
      "due_date",          // {{9}}  e.g. "25 Jun 2026"
      "max_marks",         // {{10}} e.g. "20"
      "is_mandatory",      // {{11}} e.g. "Yes"
      "description",       // {{12}} e.g. "Solve all exercise questions from Chapter 5."
      "school_name_2",     // {{13}} e.g. "Delhi Public School"  (repeated)
    ] as const,
    description: "Assignment due reminder with full details and description to parent",
  },

  // ── 12. General notification ──────────────────────────────────────────────
  // Template name: school_general_notification
  // Triggered: manually for general school-wide announcements.
  GENERAL_NOTIFICATION: {
    name: "school_general_notification",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear {{1}},\n\nA message from {{2}}. \n\nRegarding: {{3}}\n\nNotice Details: {{4}}\n\nFor official questions or assistance, contact: {{5}}\n\n{{6}}\n\nThanks!",
    variables: [
      "recipient_name",  // {{1}}  e.g. "Mr. Ramesh Verma"
      "school_name",     // {{2}}  e.g. "Greenfield School"
      "regarding",       // {{3}}  e.g. "Schedule Update"
      "notice_details",  // {{4}}  e.g. "Please review the updated administrative guidelines for the upcoming term."
      "contact",         // {{5}}  e.g. "9876543210"
      "school_name_2",   // {{6}}  e.g. "Greenfield School"  (repeated)
    ] as const,
    description: "General notification or announcement to any recipient",
  },

  // ── 13. Holiday notice ────────────────────────────────────────────────────
  // Template name: school_holiday_notice
  // Triggered: manually when declaring a school holiday.
  HOLIDAY_NOTICE: {
    name: "school_holiday_notice",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent and Staff,\n\nImportant notice from {{1}}:\n\n{{2}} will remain CLOSED on {{3}}.\n\nReason: {{4}}\nClasses Resume: {{5}}\n\n{{6}}\n\nFor queries: {{7}}\n{{8}} Administration\n\nThanks!",
    variables: [
      "school_name",        // {{1}}  e.g. "Delhi Public School"
      "school_name_2",      // {{2}}  e.g. "Delhi Public School"  (repeated)
      "closed_on",          // {{3}}  e.g. "27 Jun 2026"
      "reason",             // {{4}}  e.g. "Public Holiday - Eid-ul-Adha"
      "classes_resume",     // {{5}}  e.g. "28 Jun 2026"
      "optional_message",   // {{6}}  e.g. "" or "Stay safe and enjoy the holiday!"
      "contact",            // {{7}}  e.g. "9876543210"
      "school_name_3",      // {{8}}  e.g. "Delhi Public School"  (repeated)
    ] as const,
    description: "School holiday closure notice with reason and resumption date",
  },

  // ── 14. PTM invite ────────────────────────────────────────────────────────
  // Template name: school_ptm_invite
  // Triggered: when a PTM is scheduled for a student.
  PTM_INVITE: {
    name: "school_ptm_invite",
    category: "UTILITY" as WhatsappTemplateCategoryValue,
    language: "en",
    bodyText:
      "Dear Parent of {{1}},\n\nYou are invited to the Parent-Teacher Meeting at {{2}}.\n\nStudent: {{3}}\nClass: {{4}}\n\nPTM DETAILS\n__________________________\nDate: {{5}}\nTime Slot: {{6}}\nVenue: {{7}}\nTeacher: {{8}}\n__________________________\n\nYour attendance is important for your child's academic progress. Please be present on time.\n\nTo reschedule, contact: {{9}}\n{{10}}\n\nThanks!",
    variables: [
      "student_name",  // {{1}}  e.g. "Sakshi Jain"
      "school_name",   // {{2}}  e.g. "Sunrise Academy"
      "student_name_2",// {{3}}  e.g. "Sakshi Jain"  (repeated)
      "class_section", // {{4}}  e.g. "Class 5 - B"
      "ptm_date",      // {{5}}  e.g. "28 Jun 2026"
      "time_slot",     // {{6}}  e.g. "10:30 AM - 11:00 AM"
      "venue",         // {{7}}  e.g. "Room 12, Ground Floor, Block B"
      "teacher_name",  // {{8}}  e.g. "Mrs. Kavita Sharma"
      "contact",       // {{9}}  e.g. "9876543210"
      "school_name_2", // {{10}} e.g. "Sunrise Academy"  (repeated)
    ] as const,
    description: "Parent-Teacher Meeting invitation with schedule details",
  },
} as const;

/** Union of all valid template keys. Enforced by Zod schema on routes. */
export type PlatformTemplateKey = keyof typeof PLATFORM_TEMPLATES;

/**
 * A record of template variable name → actual value.
 * Keys are from the relevant template's `variables` array.
 * Values are always strings — numbers/dates must be pre-formatted by the caller.
 *
 * Example for FEE_PAID:
 *   { parent_name: "Mr. Sharma", amount: "1,500", fee_type: "June Tuition",
 *     payment_date: "20 Jun 2026", receipt_number: "REC-0142", school_name: "DPS" }
 */
export type TemplateVariables = Record<string, string>;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — META API TYPES (what WE send TO Meta)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Component shape used when calling POST /{phoneNumberId}/messages.
 * We only use "body" (always present) and optionally "header" (text only).
 * Button and media components are not used by our current templates.
 */
export interface WhatsappTemplateComponent {
  type: "header" | "body" | "button";
  parameters: Array<{
    type: "text" | "image" | "document" | "video";
    text?: string;
    image?: { link: string };
    document?: { link: string; filename?: string };
  }>;
  sub_type?: "quick_reply" | "url"; // only for button components
  index?: number; // only for button components
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — META WEBHOOK PAYLOAD TYPES (what Meta sends TO US)
//
// Only the fields we actually read are typed — Meta sends many more.
// Source: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
// ─────────────────────────────────────────────────────────────────────────────

/** Top-level webhook POST body from Meta. */
export interface MetaWebhookPayload {
  object: "whatsapp_business_account";
  entry: MetaWebhookEntry[];
}

/** One entry per WABA. We have one WABA so always one entry. */
export interface MetaWebhookEntry {
  id: string; // WABA ID — verify this matches our WHATSAPP_WABA_ID
  changes: MetaWebhookChange[];
}

/** One change = one batch of events for one phone number. */
export interface MetaWebhookChange {
  field: "messages"; // the only webhook field we subscribe to
  value: {
    messaging_product: "whatsapp";
    metadata: {
      display_phone_number: string; // human-readable number e.g. "+91 98765 43210"
      phone_number_id: string; // our WHATSAPP_PHONE_NUMBER_ID
    };
    /** Present when a contact sends us an inbound message. */
    contacts?: Array<{
      profile: { name: string }; // display name from WhatsApp profile
      wa_id: string; // sender's phone (E.164 without +)
    }>;
    /** Present when an inbound message arrives. */
    messages?: MetaInboundMessage[];
    /** Present when a message we sent gets a delivery/read update. */
    statuses?: MetaMessageStatus[];
    /** Present on webhook-level errors (rare, usually means config issue). */
    errors?: MetaWebhookError[];
  };
}

/** An inbound message received from a parent/student. */
export interface MetaInboundMessage {
  id: string; // wamid of the inbound message
  from: string; // sender's phone (E.164 without +) e.g. "919876543210"
  timestamp: string; // Unix timestamp as string e.g. "1750401600"
  type:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "video"
    | "sticker"
    | "reaction"
    | "unknown";
  text?: {
    body: string; // message text content
  };
  image?: {
    id: string; // Media ID — use to download via Media API if needed
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  document?: {
    id: string;
    filename: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  audio?: {
    id: string;
    mime_type: string;
    sha256: string;
    voice?: boolean; // true if recorded in WhatsApp (voice note)
  };
  video?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  /** If this message is a reply to a previous message. */
  context?: {
    from: string; // original sender's phone
    id: string; // wamid of the message being replied to
  };
  /** If the message is a reaction (emoji) to a previous message. */
  reaction?: {
    message_id: string;
    emoji: string;
  };
}

/** Delivery/read status update for a message we sent. */
export interface MetaMessageStatus {
  id: string; // wamid of OUR outbound message (matches whatsapp_messages.waMessageId)
  status: "sent" | "delivered" | "read" | "failed" | "deleted";
  timestamp: string; // Unix timestamp as string
  recipient_id: string; // phone of the person who received / read / failed
  /** Only present on status = "failed" */
  errors?: MetaWebhookError[];
  /** Conversation billing info — present when status = "sent" */
  conversation?: {
    id: string;
    expiration_timestamp?: string;
    origin: {
      type: "business_initiated" | "user_initiated" | "referral_conversion";
    };
  };
  /** Pricing info — present when billable = true */
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string; // "utility" | "marketing" | "authentication" | "service"
  };
}

/** Error detail inside a webhook payload (status.errors[] or value.errors[]). */
export interface MetaWebhookError {
  code: number; // Meta error code e.g. 131026, 131047, 132000
  title: string; // short error category e.g. "Message Undeliverable"
  message: string; // human-readable explanation
  error_data?: {
    details: string; // more detail e.g. "Recipient is not a WhatsApp user"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — SERVICE LAYER I/O SHAPES
// What the route handlers accept and what the service functions return.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for sending a single template message to one recipient.
 * Used by POST /school/whatsapp/send and by the module integration helpers
 * (attendance, fees, exams, assignments).
 */
export interface SendSingleMessageInput {
  /** Which of our 9 platform templates to use. */
  templateKey: PlatformTemplateKey;

  /**
   * Recipient's phone number.
   * The service normalises this via normalisePhone() before calling Meta.
   * Accepts: "+91 98765 43210", "9876543210", "919876543210", "0091 9876543210"
   * Meta requires E.164 WITHOUT the + prefix: "919876543210"
   */
  recipientPhone: string;

  /** Display name stored on the whatsapp_messages row (for history screen). */
  recipientName: string;

  /** Who the recipient is — stored for filtering/analytics. */
  recipientType: WhatsappRecipientTypeValue;

  /**
   * FK to school_users.id if the recipient is a school user.
   * NULL/undefined for EXTERNAL recipients (raw phone numbers).
   */
  recipientUserId?: number;

  /**
   * Variable values keyed by the variable name.
   * Keys must cover every entry in PLATFORM_TEMPLATES[templateKey].variables.
   * buildBodyParameters() will throw if any are missing.
   *
   * Example for ATTENDANCE_MARKED:
   *   { parent_name: "Mr. Sharma", student_name: "Rohan", date: "20 Jun 2026",
   *     class_section: "Class 8 - A", status: "Present", school_name: "DPS" }
   */
  variables: TemplateVariables;

  /**
   * Which application module triggered this send — stored for analytics.
   * e.g. "attendance" | "fees" | "exams" | "assignments" | "bulk" | "manual"
   */
  triggeredByModule?: string;

  /**
   * ID of the entity in the triggering module.
   * e.g. fee_payments.id, school_student_enrollments.id, school_exam_marks.id
   * Used to query "all WhatsApp messages sent for this fee payment".
   */
  triggeredByEntityId?: number;
}

/**
 * Input for initiating a bulk send operation.
 * Used by POST /school/whatsapp/bulk/initiate.
 */
export interface BulkSendInitiateInput {
  /** Human-readable title shown in bulk send history. e.g. "Fee Reminder — June 2026" */
  title: string;

  /** Which template to use for ALL messages in this bulk. */
  templateKey: PlatformTemplateKey;

  /** Who to target. */
  targetType: BulkTargetTypeValue;

  /**
   * Required when targetType is CLASS_SECTION_PARENTS or CLASS_SECTION_STUDENTS.
   * Must be a valid school_class_sections.id.
   */
  classSectionId?: number;

  /**
   * Required when targetType is CUSTOM_USER_LIST.
   * Must be valid school_users.id values (max 500 per bulk send).
   */
  userIds?: number[];

  /**
   * Required when targetType is CUSTOM_PHONE_LIST.
   * Raw phone numbers in any format — normalised by the service.
   * Max 500 per bulk send.
   */
  phoneList?: string[];

  /**
   * Variable resolution strategy.
   * Always "auto" — the server resolves template variables from the DB
   * (student name from enrollment, school name from school record, etc.).
   * Manual variable override per recipient is not supported in v1.
   */
  variableResolver: "auto";
}

// ── Service return shapes ─────────────────────────────────────────────────────

/** Returned by sendOneMessage() — both success and failure cases. */
export interface SendMessageResult {
  success: boolean;
  /** Our whatsapp_messages.id — present whether success or failure. */
  messageId?: number;
  /** Meta's wamid — only present on success. */
  wamid?: string;
  /** Error description — only present on failure. */
  error?: string;
}

/** Returned by initiateBulkSend() after credits are reserved. */
export interface BulkSendResult {
  /** Our whatsapp_bulk_sends.id — use this to call /bulk/:id/start */
  bulkSendId: number;
  /** Number of recipients resolved. */
  totalRecipients: number;
  /** Credits reserved = totalRecipients (1 per message). */
  estimatedCreditCost: number;
  /** Remaining balance after reservation. */
  creditsRemaining: number;
}
