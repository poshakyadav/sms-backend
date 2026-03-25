// src/modules/school/users/services.ts

import { and, eq, sql } from "drizzle-orm";
import { getSchoolDB } from "../../../db/school-client";
import {
  schoolUsersSchema,
  studentsSchema,
  teachersSchema,
  parentsSchema,
  staffSchema,
  schoolStudentEnrollmentsSchema,
} from "../../../db/schemas/school";
import { hashPassword } from "../../../utils/hashing";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { SchoolRole } from "../../../types/school-role";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { SchoolEnv } from "../../../types/common-types";

export async function getSchoolUsers(env: SchoolEnv['Bindings'], schoolCode: string) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select()
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .orderBy(schoolUsersSchema.name)
    .all()
    .then(users => users.map(u => ({
      ...u.school_users,
      profile: getProfile(u, u.school_users.role),
    })));
}

function getProfile(row: any, role: SchoolRole) {
  switch (role) {
    case SchoolRole.STUDENT: return row.students;
    case SchoolRole.TEACHER: return row.teachers;
    case SchoolRole.STUDENT_PARENT: return row.parents;
    default: return row.staff;
  }
}

export async function getSchoolUserById(env: SchoolEnv['Bindings'], schoolCode: string, id: number) {
  const db = await getSchoolDB(env, schoolCode);

  const user = await db
    .select()
    .from(schoolUsersSchema)
    .leftJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .leftJoin(parentsSchema, eq(schoolUsersSchema.id, parentsSchema.userId))
    .leftJoin(staffSchema, eq(schoolUsersSchema.id, staffSchema.userId))
    .where(eq(schoolUsersSchema.id, id))
    .get();

  if (!user) return null;
  return { ...user.school_users, profile: getProfile(user, user.school_users.role) };
}

export async function createSchoolUser(
  env: SchoolEnv['Bindings'],
  schoolCode: string,
  data: any,
  createdBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const passwordHash = await hashPassword(data.password);

    // Create base user with all common fields (updated for split address)
    const [newUser] = await tx
      .insert(schoolUsersSchema)
      .values({
        name: data.name,
        email: data.email,
        passwordHash,
        role: data.role,
        phone: data.phone,
        alternatePhone: data.alternatePhone,
        dateOfBirth: data.dateOfBirth,
        gender: data.gender,
        addressLineOne: data.addressLineOne,
        addressLineTwo: data.addressLineTwo,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        bloodGroup: data.bloodGroup,
        avatarUrl: data.avatarUrl,
      })
      .returning();

    // Create profile
    switch (data.role) {
      case SchoolRole.STUDENT:
        await tx.insert(studentsSchema).values({
          userId: newUser.id,
          rollNumber: data.rollNumber,
          admissionDate: data.admissionDate,
          previousSchool: data.previousSchool,
          medicalInfo: data.medicalInfo,
        });
        break;
      case SchoolRole.TEACHER:
        await tx.insert(teachersSchema).values({
          userId: newUser.id,
          qualification: data.qualification,
          experienceYears: data.experienceYears,
          joiningDate: data.joiningDate,
          specialization: data.specialization,
        });
        break;
      case SchoolRole.STUDENT_PARENT:
        await tx.insert(parentsSchema).values({
          userId: newUser.id,
          occupation: data.occupation,
        });
        break;
      default: // Staff
        await tx.insert(staffSchema).values({
          userId: newUser.id,
          designation: data.role,
          department: data.department,
          joiningDate: data.joiningDate,
          salary: data.salary,
          shift: data.shift,
        });
        break;
    }

    // Welcome email
    const emailData: BrevoSendEmailRequest = {
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: data.email, name: data.name }],
      subject: `Welcome to ${schoolCode} - Account Created`,
      htmlContent: `<h2>Welcome ${data.name}!</h2><p>Role: ${data.role}</p><p>Email: ${data.email}</p><p>Password: ${data.password} (change soon)</p>`,
    };
    await sendTransactionalEmail(env, emailData).catch(console.error);

    return { user: newUser, message: 'User created' };
  });
}

export async function updateSchoolUser(
  env: SchoolEnv['Bindings'],
  schoolCode: string,
  id: number,
  data: any,
  updatedBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    if (data.newPassword) data.passwordHash = await hashPassword(data.newPassword);

    // Update base user (updated for split address)
    await tx.update(schoolUsersSchema)
      .set({
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
        phone: data.phone,
        alternatePhone: data.alternatePhone,
        dateOfBirth: data.dateOfBirth,
        gender: data.gender,
        addressLineOne: data.addressLineOne,
        addressLineTwo: data.addressLineTwo,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
        bloodGroup: data.bloodGroup,
        avatarUrl: data.avatarUrl,
        isActive: data.isActive,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolUsersSchema.id, id));

    // Update profile based on role (fetch role first)
    const user = await tx.select({ role: schoolUsersSchema.role }).from(schoolUsersSchema).where(eq(schoolUsersSchema.id, id)).get();
    if (!user) throw new Error('User not found');

    switch (user.role) {
      case SchoolRole.STUDENT:
        await tx.update(studentsSchema)
          .set({
            rollNumber: data.rollNumber,
            admissionDate: data.admissionDate,
            previousSchool: data.previousSchool,
            medicalInfo: data.medicalInfo,
          })
          .where(eq(studentsSchema.userId, id));
        break;
      case SchoolRole.TEACHER:
        await tx.update(teachersSchema)
          .set({
            qualification: data.qualification,
            experienceYears: data.experienceYears,
            joiningDate: data.joiningDate,
            specialization: data.specialization,
          })
          .where(eq(teachersSchema.userId, id));
        break;
      case SchoolRole.STUDENT_PARENT:
        await tx.update(parentsSchema)
          .set({ occupation: data.occupation })
          .where(eq(parentsSchema.userId, id));
        break;
      default:
        await tx.update(staffSchema)
          .set({
            department: data.department,
            joiningDate: data.joiningDate,
            salary: data.salary,
            shift: data.shift,
          })
          .where(eq(staffSchema.userId, id));
        break;
    }

    // Email if password changed
    if (data.newPassword) {
      const emailData: BrevoSendEmailRequest = {
        sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
        to: [{ email: data.email, name: data.name }],
        subject: `Password Updated for ${schoolCode}`,
        htmlContent: `<p>Your password has been updated. New password: ${data.newPassword}</p>`,
      };
      await sendTransactionalEmail(env, emailData).catch(console.error);
    }

    return { message: 'User updated' };
  });
}

export async function deleteSchoolUser(env: SchoolEnv['Bindings'], schoolCode: string, id: number) {
  const db = await getSchoolDB(env, schoolCode);

  // Check dependencies (e.g., can't delete if has enrollments) - add as needed
  // For example:
  const enrollments = await db.select().from(schoolStudentEnrollmentsSchema).where(eq(schoolStudentEnrollmentsSchema.studentId, id)).limit(1).get();
  if (enrollments) throw new Error('Cannot delete user with active enrollments');

  await db.delete(schoolUsersSchema).where(eq(schoolUsersSchema.id, id));
  return { message: 'User deleted' };
}