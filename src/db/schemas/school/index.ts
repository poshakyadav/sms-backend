// Base tables (no or minimal dependencies)
export * from "./school-users";
export * from "./schools";
export * from "./refresh-tokens"; // Depends on school-users

// School config tables
export * from "./school-academic-years"; // Depends on schools
export * from "./school-classes"; // Depends on schools
export * from "./school-sections"; // Depends on schools
export * from "./school-class-sections"; // Depends on schools, classes, sections, school-users
export * from "./school-subjects"; // No deps
export * from "./school-class-section-subjects"; // Depends on classes, subjects

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
export * from "./school-teacher-assignments"; // Depends on teachers, class_subjects
export * from "./school-notifications"; // Depends on school-users
export * from "./school-notification-interactions"; // Depends on notifications, school-users
export * from "./school-attendances"; // Depends on student_enrollments, school-users
export * from "./school-fee-payments"; // Depends on student_enrollments, fee_structures, school-users
export * from "./school-exams"; // Depends on academic_years, class_subjects
export * from "./school-exam-marks"; // Depends on exams, student_enrollments, school-users
export * from "./school-assignments"; // Depends on teacher_assignments, school-users
export * from "./school-assignment-submissions"; // Depends on assignments, student_enrollments, school-users


// Relations (keep at end if needed)
export * from "./school-users-relations";
export * from "./school-class-sections-relations";
