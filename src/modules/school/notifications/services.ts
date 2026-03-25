import { getSchoolDB } from "../../../db/school-client";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  schoolNotificationsSchema,
  schoolUsersSchema,
  schoolNotificationInteractionsSchema,
  studentParentsSchema,
  TargetType,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { schoolStudentEnrollmentsSchema } from "../../../db/schemas/school";
import {
  InternalStaffRoles,
  OperationsStaffRoles,
  SchoolRole,
  StaffRoles,
} from "../../../types/school-role";

// ==================== HELPER: Build target conditions (DRY) ====================
const buildTargetConditions = (
  userId: number,
  userRole: SchoolRole,
  userClassSectionId: number | null
) => {
  const conditions = [
    eq(schoolNotificationsSchema.targetType, TargetType.SCHOOL),
    and(
      eq(schoolNotificationsSchema.targetType, TargetType.STUDENT),
      eq(schoolNotificationsSchema.studentId, userId)
    ),
  ];

  if (StaffRoles.some((r) => r === userRole))
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.ALL_STAFF)
    );

  if (InternalStaffRoles.some((r) => r === userRole))
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.INTERNAL_STAFF)
    );

  if (OperationsStaffRoles.some((r) => r === userRole))
    conditions.push(
      eq(schoolNotificationsSchema.targetType, TargetType.OPERATION_STAFF)
    );

  // Student / Parent targeting via classSectionId
  if (
    (userRole === SchoolRole.STUDENT ||
      userRole === SchoolRole.STUDENT_PARENT) &&
    userClassSectionId !== null
  ) {
    conditions.push(
      and(
        or(
          eq(schoolNotificationsSchema.targetType, TargetType.CLASS),
          eq(schoolNotificationsSchema.targetType, TargetType.EXTERNAL_USER),
          eq(schoolNotificationsSchema.targetType, TargetType.STUDENT_PARENT)
        ),
        eq(schoolNotificationsSchema.classSectionId, userClassSectionId)
      )
    );
  }

  return conditions;
};

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
// ==================== Get Notifications ====================
export async function getNotifications(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  userId: number,
  userRole: SchoolRole
) {
  const db = await getSchoolDB(env, schoolCode);

  // Resolve user's current classSectionId
  let userClassSectionId: number | null = null;

  if (userRole === SchoolRole.STUDENT) {
    const enrollment = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.studentId, userId))
      .get();
    userClassSectionId = enrollment?.classSectionId ?? null;
  } else if (userRole === SchoolRole.STUDENT_PARENT) {
    const child = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(studentParentsSchema)
      .innerJoin(
        schoolStudentEnrollmentsSchema,
        eq(
          studentParentsSchema.studentId,
          schoolStudentEnrollmentsSchema.studentId
        )
      )
      .where(eq(studentParentsSchema.parentId, userId))
      .get();
    userClassSectionId = child?.classSectionId ?? null;
  }

  const conditions = buildTargetConditions(
    userId,
    userRole,
    userClassSectionId
  );

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
  userId: number,
  userRole: SchoolRole
) {
  const db = await getSchoolDB(env, schoolCode);

  let userClassSectionId: number | null = null;

  if (userRole === SchoolRole.STUDENT) {
    const enrollment = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.studentId, userId))
      .get();
    userClassSectionId = enrollment?.classSectionId ?? null;
  } else if (userRole === SchoolRole.STUDENT_PARENT) {
    const child = await db
      .select({ classSectionId: schoolStudentEnrollmentsSchema.classSectionId })
      .from(studentParentsSchema)
      .innerJoin(
        schoolStudentEnrollmentsSchema,
        eq(
          studentParentsSchema.studentId,
          schoolStudentEnrollmentsSchema.studentId
        )
      )
      .where(eq(studentParentsSchema.parentId, userId))
      .get();
    userClassSectionId = child?.classSectionId ?? null;
  }

  const conditions = buildTargetConditions(
    userId,
    userRole,
    userClassSectionId
  );

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
    case TargetType.SCHOOL:
      const all = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.isActive, true))
        .get();
      totalPotential = all?.count ?? 0;
      break;

    case TargetType.ALL_STAFF:
    case TargetType.INTERNAL_STAFF:
    case TargetType.OPERATION_STAFF:
      const staffRoles =
        notif.targetType === TargetType.ALL_STAFF
          ? StaffRoles
          : notif.targetType === TargetType.INTERNAL_STAFF
          ? InternalStaffRoles
          : OperationsStaffRoles;
      const staff = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(schoolUsersSchema)
        .where(
          and(
            eq(schoolUsersSchema.isActive, true),
            inArray(schoolUsersSchema.role, staffRoles)
          )
        )
        .get();
      totalPotential = staff?.count ?? 0;
      break;

    case TargetType.STUDENT:
      totalPotential = 1;
      break;

    case TargetType.CLASS:
    case TargetType.EXTERNAL_USER:
    case TargetType.STUDENT_PARENT:
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
