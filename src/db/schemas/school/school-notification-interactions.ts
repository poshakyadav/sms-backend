import {
  integer,
  sqliteTable,
  text,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { schoolNotificationsSchema } from "./school-notifications";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const schoolNotificationInteractionsSchema = sqliteTable(
  "notification_interactions",
  {
    notificationId: integer("notification_id")
      .references(() => schoolNotificationsSchema.id, { onDelete: "cascade" })
      .notNull(),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),
    userId: integer("user_id")
      .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
      .notNull(),
    isRead: integer("is_read", { mode: "boolean" }).default(false).notNull(),
    readAt: text("read_at"),
    isArchived: integer("is_archived", { mode: "boolean" })
      .default(false)
      .notNull(),
  },
  (table) => ({
    // Composite PK = zero duplicates + lightning-fast lookups
    pk: primaryKey({ columns: [table.notificationId, table.userId] }),
  })
);

export type SchoolNotificationInteraction =
  typeof schoolNotificationInteractionsSchema.$inferSelect;
export type NewSchoolNotificationInteraction =
  typeof schoolNotificationInteractionsSchema.$inferInsert;
