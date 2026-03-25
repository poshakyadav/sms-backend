// src/modules/users/services.ts
import { superUsersSchema } from '../../../db';
import { eq } from 'drizzle-orm';
import { SuperRole } from '../../../types/super-role';
import { hashPassword } from '../../../utils/hashing';

export async function getUsers(db: any) {
  return db.select().from(superUsersSchema).all();
}

export async function getUserById(db: any, id: number) {
  return db.select().from(superUsersSchema).where(eq(superUsersSchema.id, id)).get();
}

export async function createUser(db: any, data: { name: string; email: string; password: string; role: SuperRole }) {
  const { name, email, password, role } = data;
  const existing = await db.select().from(superUsersSchema).where(eq(superUsersSchema.email, email)).get();
  if (existing) throw new Error('Email taken');

  const passwordHash = await hashPassword(password);
  const [newUser] = await db.insert(superUsersSchema).values({ name, email, passwordHash, role }).returning();
  return newUser;
}

export async function updateUser(db: any, id: number, data: Partial<{ name: string; email: string; password: string; role: SuperRole }>) {
  const updates: any = { ...data };
  if (updates.password) updates.passwordHash = await hashPassword(updates.password);
  delete updates.password;

  const [updatedUser] = await db.update(superUsersSchema).set(updates).where(eq(superUsersSchema.id, id)).returning();
  if (!updatedUser) throw new Error('User not found');
  return updatedUser;
}

export async function deleteUser(db: any, id: number) {
  const [deleted] = await db.delete(superUsersSchema).where(eq(superUsersSchema.id, id)).returning();
  if (!deleted) throw new Error('User not found');
  return deleted;
}