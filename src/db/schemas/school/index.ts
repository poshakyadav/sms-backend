// Base tables (no or minimal dependencies)
export * from "./school-users";
export * from "./schools";
export * from "./refresh-tokens"; // Depends on school-users
export * from "./school-theme-configs";

// NEW PERMISSION SYSTEM (add here)
export * from "./school-permissions";
export * from "./school-roles";
export * from "./school-role-permissions";
export * from "./school-user-roles";
export * from "./school-user-permissions";
export * from "./school-user-permission-denials";

// About Us (singleton)
export * from "./school-about-us";

// School config tables
export * from "./school-academic-years"; // Depends on schools
export * from "./school-classes"; // Depends on schools
export * from "./school-sections"; // Depends on schools
export * from "./school-class-sections"; // Depends on schools, classes, sections, school-users
export * from "./school-subjects"; // No deps
export * from "./school-class-section-subjects"; // Depends on classes, subjects

// ── WhatsApp  ──────────────────────
export * from "./whatsapp-balance";
export * from "./whatsapp-bundle-credits";

export * from "./whatsapp-templates";
export * from "./whatsapp-messages";
export * from "./whatsapp-bulk-sends";
export * from "./whatsapp-inbound-messages";

// ID Cards (depends on schools, school-users, school-student-enrollments)
export * from "./id-card-templates";
export * from "./id-cards";


// User profiles (depend on school-users)
export * from "./students";
export * from "./teachers";
export * from "./parents";
export * from "./staff";

// Relations and features (depend on above)
export * from "./student-parents"; // Depends on students, parents
export * from "./school-student-enrollments"; // Depends on students, academic_years, classes, sections
export * from "./school-class-section-mappings";
export * from "./school-fee-structures"; // Depends on academic_years, classes
export * from "./school-fee-concessions";        // per-student discounts
export * from "./school-student-fee-assignments"; // transport/hostel/custom fees
export * from "./school-teacher-assignments"; // Depends on teachers, class_subjects

export * from "./school-feed-posts";
export * from "./school-feed-post-interactions";


export * from "./school-notifications"; // Depends on school-users
export * from "./school-notification-interactions"; // Depends on notifications, school-users
export * from "./school-attendances"; // Depends on student_enrollments, school-users
export * from "./school-fee-payments"; // Depends on student_enrollments, fee_structures,  school-users and nullable feeStructureId + studentFeeAssignmentId
export * from "./school-exams"; // Depends on academic_years, class_subjects
export * from "./school-exam-marks"; // Depends on exams, student_enrollments, school-users
export * from "./school-exam-subjects"; // Depends on exams, class_section_subjects
export * from "./school-assignments"; // Depends on teacher_assignments, school-users
export * from "./school-assignment-submissions"; // Depends on assignments, student_enrollments, school-users

// Relations (keep at end if needed)
export * from "./school-users-relations";
export * from "./school-class-sections-relations";
export * from "./school-theme-configs-relations";
