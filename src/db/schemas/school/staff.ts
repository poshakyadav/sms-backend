// General table for all non-academic roles – as you preferred
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schoolUsersSchema } from "./school-users";
import { schoolsSchema } from "./schools";

export const staffSchema = sqliteTable("staff", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => schoolUsersSchema.id, { onDelete: "cascade" }),
  schoolId: integer("school_id")
    .references(() => schoolsSchema.id, { onDelete: "cascade" })
    .notNull()
    .default(1),
  designation: text("designation").notNull(), // e.g., "TRANSPORT_STAFF", "ACCOUNTANT"
  department: text("department"),
  joiningDate: text("joining_date"),
  salary: integer("salary"),
  shift: text("shift"),
});

export type Staff = typeof staffSchema.$inferSelect;
export type NewStaff = typeof staffSchema.$inferInsert;
