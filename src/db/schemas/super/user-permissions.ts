import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { superUsersSchema } from './super-users';
import { Permission } from '../../../types/permissions';

export const userPermissionsSchema = sqliteTable('user_permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => superUsersSchema.id, { onDelete: 'cascade' }).notNull(),
  permission: text('permission').$type<Permission>().notNull(),
  allowed: integer('allowed', { mode: 'boolean' }).notNull().default(false),
});

export type UserPermission = typeof userPermissionsSchema.$inferSelect;
export type NewUserPermission = typeof userPermissionsSchema.$inferInsert;