import { superUsersSchema, schoolsSchema, tursoDatabasesSchema } from '../../../db';
import { count } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

export async function getDashboardStats(db: any) {
  const usersCount = await db.select({ value: count() }).from(superUsersSchema).get().then((res: any) => res.value || 0);
  const schoolsCount = await db.select({ value: count() }).from(schoolsSchema).get().then((res: any) => res.value || 0);
  const availableDbsCount = await db.select({ value: count() }).from(tursoDatabasesSchema).where(eq(tursoDatabasesSchema.isAssigned, false)).get().then((res: any) => res.value || 0);

  return {
    users: usersCount,
    schools: schoolsCount,
    availableDbs: availableDbsCount,
  };
}