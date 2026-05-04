// ../school/notifications/services.ts

import { getSchoolDB } from "../../../db/school-client";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  schoolNotificationsSchema,
  schoolUsersSchema,
  schoolNotificationInteractionsSchema,
  studentParentsSchema,
  TargetType,
  schoolRolesSchema,
  schoolUserRolesSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { schoolStudentEnrollmentsSchema } from "../../../db/schemas/school";
import {
  InternalStaffRoles,
  OperationsStaffRoles,
  SchoolRole,
  StaffRoles,
} from "../../../types/school-role";

// ==================== HELPER: Resolve user's role names from DB ====================
/**
 * PBAC-compatible: fetches the user's actual role names from the user_roles
 * junction table rather than reading a (now-deleted) `role` column on school_users.
 */
async function getUserRoleNames(db: any, userId: number): Promise<string[]> {
  const rows = await db
    .select({ roleName: schoolRolesSchema.name })
    .from(schoolUserRolesSchema)
    .innerJoin(
      schoolRolesSchema,
      eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
    )
    .where(eq(schoolUserRolesSchema.userId, userId))
    .all();

  return rows.map((r: { roleName: string }) => r.roleName);
}

// ==================== HELPER: Resolve user's active class-section ====================
/**
 * Returns the classSectionId for STUDENT and STUDENT_PARENT roles.
 * Uses role names (not user.role) to decide which lookup to perform.
 */
async function resolveUserClassSectionId(
  db: any,
  userId: number,
  roleNames: string[]
): Promise<number | null> {
  if (roleNames.includes(SchoolRole.STUDENT)) {
    const enrollment = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, userId),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get();
    return enrollment?.classSectionId ?? null;
  }

  if (roleNames.includes(SchoolRole.STUDENT_PARENT)) {
    const child = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(studentParentsSchema)
      .innerJoin(
        schoolStudentEnrollmentsSchema,
        and(
          eq(
            studentParentsSchema.studentId,
            schoolStudentEnrollmentsSchema.studentId
          ),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .where(eq(studentParentsSchema.parentId, userId))
      .get();
    return child?.classSectionId ?? null;
  }

  return null;
}

// ==================== HELPER: Build OR conditions for notification targeting ====================
function buildTargetConditions(
  userId: number,
  roleNames: string[],
  classSectionId: number | null
) {
  const conditions: any[] = [
    // Everyone sees SCHOOL-wide notifications
    eq(schoolNotificationsSchema.targetType, TargetType.SCHOOL),
    // Direct STUDENT-targeted notification
    and(
      eq(schoolNotificationsSchema.targetType, TargetType.STUDENT),
      eq(schoolNotificationsSchema.studentId, userId)
    ),
  ];

  // Staff-level targeting (role-name based, not role-column based)
  const isStaff = StaffRoles.some((r) => roleNames.includes(r));
  if (isStaff)
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.ALL_STAFF)
    );

  const isInternalStaff = InternalStaffRoles.some((r) => roleNames.includes(r));
  if (isInternalStaff)
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.INTERNAL_STAFF)
    );

  const isOperationsStaff = OperationsStaffRoles.some((r) =>
    roleNames.includes(r)
  );
  if (isOperationsStaff)
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.OPERATION_STAFF)
    );

  // Class/parent targeting via classSectionId
  const isStudentOrParent =
    roleNames.includes(SchoolRole.STUDENT) ||
    roleNames.includes(SchoolRole.STUDENT_PARENT);

  if (isStudentOrParent && classSectionId !== null) {
    conditions.push(
      and(
        or(
          eq(schoolNotificationsSchema.targetType, TargetType.CLASS),
          eq(schoolNotificationsSchema.targetType, TargetType.EXTERNAL_USER),
          eq(schoolNotificationsSchema.targetType, TargetType.STUDENT_PARENT)
        ),
        eq(schoolNotificationsSchema.classSectionId, classSectionId)
      )
    );
  }

  return conditions;
}

// ==================== Create Notification ====================
export async function createNotification(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any,
  senderId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const [newNotification] = await db
    .insert(schoolNotificationsSchema)
    .values({ ...data, senderId })
    .returning();

  return { notification: newNotification, message: "Notification created" };
}

// ==================== Get Notifications (Fan-out on Read) ====================
export async function getNotifications(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const roleNames = await getUserRoleNames(db, userId);
  const classSectionId = await resolveUserClassSectionId(db, userId, roleNames);
  const conditions = buildTargetConditions(userId, roleNames, classSectionId);

  return await db
    .select({
      id: schoolNotificationsSchema.id,
      title: schoolNotificationsSchema.title,
      message: schoolNotificationsSchema.message,
      createdAt: schoolNotificationsSchema.createdAt,
      dueDate: schoolNotificationsSchema.dueDate,
      link: schoolNotificationsSchema.link,
      isRead: sql<boolean>`COALESCE(${schoolNotificationInteractionsSchema.isRead}, false)`,
    })
    .from(schoolNotificationsSchema)
    .leftJoin(
      schoolNotificationInteractionsSchema,
      and(
        eq(
          schoolNotificationInteractionsSchema.notificationId,
          schoolNotificationsSchema.id
        ),
        eq(schoolNotificationInteractionsSchema.userId, userId)
      )
    )
    .where(
      and(
        or(...conditions),
        or(
          isNull(schoolNotificationInteractionsSchema.isArchived),
          eq(schoolNotificationInteractionsSchema.isArchived, false)
        )
      )
    )
    .orderBy(desc(schoolNotificationsSchema.createdAt));
}

// ==================== Mark Read (Lazy upsert) ====================
export async function markNotificationRead(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  notificationId: number,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  await db
    .insert(schoolNotificationInteractionsSchema)
    .values({
      notificationId,
      userId,
      isRead: true,
      readAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        schoolNotificationInteractionsSchema.notificationId,
        schoolNotificationInteractionsSchema.userId,
      ],
      set: { isRead: true, readAt: new Date().toISOString() },
    });

  return { message: "Notification marked as read" };
}

// ==================== Get Unread Count ====================
export async function getUnreadCount(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const roleNames = await getUserRoleNames(db, userId);
  const classSectionId = await resolveUserClassSectionId(db, userId, roleNames);
  const conditions = buildTargetConditions(userId, roleNames, classSectionId);

  const result = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${schoolNotificationsSchema.id})`,
    })
    .from(schoolNotificationsSchema)
    .leftJoin(
      schoolNotificationInteractionsSchema,
      and(
        eq(
          schoolNotificationInteractionsSchema.notificationId,
          schoolNotificationsSchema.id
        ),
        eq(schoolNotificationInteractionsSchema.userId, userId)
      )
    )
    .where(
      and(
        or(...conditions),
        or(
          isNull(schoolNotificationInteractionsSchema.isRead),
          eq(schoolNotificationInteractionsSchema.isRead, false)
        ),
        or(
          isNull(schoolNotificationInteractionsSchema.isArchived),
          eq(schoolNotificationInteractionsSchema.isArchived, false)
        )
      )
    )
    .get();

  return result?.count ?? 0;
}

// ==================== Get Notification Report (Admin) ====================
export async function getNotificationReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const notif = await db
    .select()
    .from(schoolNotificationsSchema)
    .where(eq(schoolNotificationsSchema.id, id))
    .get();

  if (!notif) throw new Error("Notification not found");

  let totalPotential = 0;

  switch (notif.targetType) {
    case TargetType.SCHOOL: {
      const all = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.isActive, true))
        .get();
      totalPotential = all?.count ?? 0;
      break;
    }

    case TargetType.ALL_STAFF:
    case TargetType.INTERNAL_STAFF:
    case TargetType.OPERATION_STAFF: {
      /**
       * PBAC FIX: Instead of querying the deleted `role` column on school_users,
       * we count users who have at least one role matching the target group.
       * We join user_roles → roles and filter by role name.
       */
      const targetRoles =
        notif.targetType === TargetType.ALL_STAFF
          ? StaffRoles
          : notif.targetType === TargetType.INTERNAL_STAFF
          ? InternalStaffRoles
          : OperationsStaffRoles;

      const staff = await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${schoolUserRolesSchema.userId})`,
        })
        .from(schoolUserRolesSchema)
        .innerJoin(
          schoolRolesSchema,
          eq(schoolUserRolesSchema.roleId, schoolRolesSchema.id)
        )
        .innerJoin(
          schoolUsersSchema,
          eq(schoolUserRolesSchema.userId, schoolUsersSchema.id)
        )
        .where(
          and(
            eq(schoolUsersSchema.isActive, true),
            inArray(schoolRolesSchema.name, [...targetRoles])
          )
        )
        .get();
      totalPotential = staff?.count ?? 0;
      break;
    }

    case TargetType.STUDENT: {
      totalPotential = 1;
      break;
    }

    case TargetType.CLASS:
    case TargetType.EXTERNAL_USER:
    case TargetType.STUDENT_PARENT: {
      const conds = [
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          notif.classSectionId!
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true),
      ];

      const studentsCount = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schoolStudentEnrollmentsSchema)
        .where(and(...conds))
        .get();

      let parentsCount = 0;
      if (
        notif.targetType === TargetType.STUDENT_PARENT ||
        notif.targetType === TargetType.EXTERNAL_USER
      ) {
        const p = await db
          .select({
            count: sql<number>`COUNT(DISTINCT ${studentParentsSchema.parentId})`,
          })
          .from(schoolStudentEnrollmentsSchema)
          .innerJoin(
            studentParentsSchema,
            eq(
              studentParentsSchema.studentId,
              schoolStudentEnrollmentsSchema.studentId
            )
          )
          .where(and(...conds))
          .get();
        parentsCount = p?.count ?? 0;
      }

      totalPotential = (studentsCount?.count ?? 0) + parentsCount;
      break;
    }
  }

  const readResult = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schoolNotificationInteractionsSchema)
    .where(
      and(
        eq(schoolNotificationInteractionsSchema.notificationId, id),
        eq(schoolNotificationInteractionsSchema.isRead, true)
      )
    )
    .get();

  const readCount = readResult?.count ?? 0;

  return {
    total: totalPotential,
    readCount,
    unread: totalPotential - readCount,
    percentageRead:
      totalPotential > 0 ? Math.round((readCount / totalPotential) * 100) : 0,
  };
}
