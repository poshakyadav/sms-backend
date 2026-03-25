import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolUsersSchema } from "./school-users";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolsSchema } from "./schools";

// Target Types Enum-like structure
export const TargetType = {
  SCHOOL: "SCHOOL", // Send Notifications to all School Users (Send to all roles users)
  CLASS: "CLASS", // Send Notifications to Specific Class and Section all Students
  STUDENT: "STUDENT", // Send Notifications to Specific Student only
  ALL_STAFF: "ALL_STAFF", // Send Notification for all StaffRoles users
  INTERNAL_STAFF: "INTERNAL_STAFF", // Send Notifications for all InternalStaffRoles users including SCHOOL_OWNER
  OPERATION_STAFF: "OPERATION_STAFF", // Send Notifications for OperationsStaffRoles users
  STUDENT_PARENT: "STUDENT_PARENT", // Send Notifications for parents only and if classId and sectionId is geven then send only that class and section all students parents
  EXTERNAL_USER: "EXTERNAL_USER" // Send notifications to Student and his Parent for a specific Class and Section
} as const;

export const schoolNotificationsSchema = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
    title: text("title").notNull(),
    message: text("message").notNull(),
    targetType: text("target_type").$type<keyof typeof TargetType>().notNull(),

    // Targeting criteria
    classId: integer("class_id"), // kept for CLASS-level targeting
    // sectionId: integer("section_id"),

    classSectionId: integer("class_section_id")
      .references(() => schoolClassSectionsSchema.id, { onDelete: "set null" }),

    studentId: integer("student_id"),

    dueDate: text("due_date"),
    link: text("link"),
    senderId: integer("sender_id")
      .references(() => schoolUsersSchema.id)
      .notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => ({
    targetIdx: index("target_idx").on(table.targetType, table.classId, table.classSectionId),
    createdIdx: index("created_idx").on(table.createdAt),
  })
);

export type SchoolNotification = typeof schoolNotificationsSchema.$inferSelect;
export type NewSchoolNotification = typeof schoolNotificationsSchema.$inferInsert;