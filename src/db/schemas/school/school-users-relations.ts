import { relations } from "drizzle-orm";
import { schoolUsersSchema } from "./school-users";
import { studentsSchema } from "./students";
import { teachersSchema } from "./teachers";
import { parentsSchema } from "./parents";
import { staffSchema } from "./staff";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolAttendancesSchema } from "./school-attendances";
import { schoolFeePaymentsSchema } from "./school-fee-payments";
import { schoolTeacherAssignmentsSchema } from "./school-teacher-assignments";
import { schoolExamMarksSchema } from "./school-exam-marks";
import {
  schoolAssignmentsSchema,
} from "./school-assignments";
import {
  schoolNotificationsSchema,
} from "./school-notifications";
import { schoolAssignmentSubmissionsSchema } from "./school-assignment-submissions";
import { schoolNotificationInteractionsSchema } from "./school-notification-interactions";
import { schoolClassSectionsSchema } from "./school-class-sections";

export const schoolUsersRelations = relations(
  schoolUsersSchema,
  ({ one, many }) => ({
    studentProfile: one(studentsSchema, {
      fields: [schoolUsersSchema.id],
      references: [studentsSchema.userId],
    }),
    teacherProfile: one(teachersSchema, {
      fields: [schoolUsersSchema.id],
      references: [teachersSchema.userId],
    }),
    parentProfile: one(parentsSchema, {
      fields: [schoolUsersSchema.id],
      references: [parentsSchema.userId],
    }),
    staffProfile: one(staffSchema, {
      fields: [schoolUsersSchema.id],
      references: [staffSchema.userId],
    }),
    
    enrollments: many(schoolStudentEnrollmentsSchema),
    attendances: many(schoolAttendancesSchema), // For teachers: attendances they marked
    feePayments: many(schoolFeePaymentsSchema), // For students/accountants
    teacherAssignments: many(schoolTeacherAssignmentsSchema), // For teachers
    examMarks: many(schoolExamMarksSchema), // For students/teachers
    assignments: many(schoolAssignmentsSchema), // For teachers
    assignmentSubmissions: many(schoolAssignmentSubmissionsSchema), // For students/teachers
    notifications: many(schoolNotificationsSchema), // For senders
    notificationInteractions: many(schoolNotificationInteractionsSchema), 

    // ── NEW: Class sections where this user is the class teacher ──
    classSectionsAsClassTeacher: many(schoolClassSectionsSchema, {
      // We tell Drizzle which field in class_sections points back to this user
      relationName: "class_teacher",   // ← optional but strongly recommended when there can be ambiguity later
    }),
  })
);
