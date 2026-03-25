import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  schoolAssignmentsSchema,
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolClassSectionSubjectsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolSubjectsSchema,
  schoolTeacherAssignmentsSchema,
  schoolUsersSchema,
} from "../../../db/schemas/school";
import { schoolAssignmentSubmissionsSchema } from "../../../db/schemas/school/school-assignment-submissions";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { createNotification } from "../notifications/services";

/**
 * Enriched Assignment Type (for frontend)
 * Contains all necessary display data + submission status for students/teachers.
 */
export interface EnrichedAssignment {
  id: number;
  teacherAssignmentId: number;
  classSectionId: number;
  type: string;
  title: string;
  description: string;
  dueDate?: string;
  targetDate?: string;
  maxMarks?: number;
  isMandatory: boolean;
  enteredBy: number;
  createdAt: string;
  updatedAt: string;
  className: string;
  sectionName: string;
  subjectName: string;
  teacherName: string;
  // Only populated for ASSIGNMENT
  studentStatus?: string; // PENDING | MARKED_AS_DONE
  teacherStatus?: string; // NOT_RECEIVED | RECEIVED | GRADED
  marksObtained?: number | null;
  receivedAt?: string;
}

/**
 * CREATE ASSIGNMENT
 *
 * Purpose: Creates a new assignment (Classwork / Homework / Assignment) and
 * automatically generates submission records for all students in the target class-section
 * when type = "ASSIGNMENT".
 *
 * How it works:
 * 1. Validates teacher assignment and class section
 * 2. Inserts the assignment
 * 3. If ASSIGNMENT type → bulk inserts submission rows (one per student)
 * 4. Sends notification asynchronously to the class
 *
 * @param data - Assignment details (teacherAssignmentId, classSectionId, type, etc.)
 * @returns Created assignment with success message
 */
export async function createAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any,
  enteredBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  console.log("Creating assignment with data:", data);

  // Validate teacher assignment exists
  const teacherAssignment = await db
    .select({ classSubjectId: schoolTeacherAssignmentsSchema.classSubjectId })
    .from(schoolTeacherAssignmentsSchema)
    .where(eq(schoolTeacherAssignmentsSchema.id, data.teacherAssignmentId))
    .get();
  if (!teacherAssignment) throw new Error("Invalid teacher assignment ID");

  console.log("Validated teacher assignment:", teacherAssignment);

  // Validate class-section exists
  const sectionExists = await db
    .select()
    .from(schoolClassSectionsSchema)
    .where(eq(schoolClassSectionsSchema.id, data.classSectionId))
    .get();
  if (!sectionExists) throw new Error("Invalid class section");

  // 2. PRIMARY DATA TRANSACTION
  // We wrap Assignment + Submissions. This MUST be fast.
  const newAssignment = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schoolAssignmentsSchema)
      .values({
        teacherAssignmentId: data.teacherAssignmentId,
        classSectionId: data.classSectionId,
        type: data.type,
        title: data.title,
        description: data.description,
        dueDate: data.dueDate || null,
        targetDate: data.targetDate || null,
        maxMarks: data.maxMarks || null,
        isMandatory: data.isMandatory ?? true,
        enteredBy,
      })
      .returning();

    // Auto-create submissions for ASSIGNMENT type
    if (data.type === "ASSIGNMENT") {
      const enrollments = await tx
        .select({ id: schoolStudentEnrollmentsSchema.id })
        .from(schoolStudentEnrollmentsSchema)
        .where(
          eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
        );

      if (enrollments.length > 0) {
        const submissionRows = enrollments.map((e) => ({
          assignmentId: inserted.id,
          enrollmentId: e.id,
          studentStatus: "PENDING",
          teacherStatus: "NOT_RECEIVED",
          enteredBy,
        }));
        await tx
          .insert(schoolAssignmentSubmissionsSchema)
          .values(submissionRows);
      }
    }
    return inserted;
  });

  // 3. ASYNC NOTIFICATION (OUTSIDE THE TRANSACTION)
  // We use .catch() and don't strictly block the response if possible
  // or await it here safely since the DB session above is already closed/committed.
  try {
    console.log("🔔 Starting notification process...");
    await createNotification(
      env,
      schoolCode,
      {
        title: `New ${data.type}: ${data.title}`,
        message: `${data.description}\n\nDate: ${
          data.targetDate || data.dueDate || "No date"
        }\n\nCheck your assignments.`,
        targetType: "CLASS",
        classSectionId: data.classSectionId,
        link: "/school/assignments",
        dueDate: data.dueDate || data.targetDate,
      },
      enteredBy
    );
    console.log("Logs after creating the notifications");
  } catch (notifError) {
    // We log it but the teacher still gets their success response
    console.error(
      "Notification failed but assignment was created:",
      notifError
    );
  }

  return {
    assignment: newAssignment,
    message:
      data.type === "ASSIGNMENT"
        ? "Assignment created with submissions for all students"
        : "Classwork/Homework published successfully",
  };
}

/**
 * GET ASSIGNMENTS (Staff View with filters)
 *
 * Purpose: Returns enriched list of assignments for teachers/principals with optional filters.
 * Used in staff dashboard for viewing all published assignments.
 *
 * @param filters - date range, classSectionId, teacherId, etc.
 * @returns Array of EnrichedAssignment
 */
export async function getAssignments(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  filters: {
    dateFrom?: string;
    dateTo?: string;
    classSubjectId?: number;
    classSectionId?: number;
    teacherId?: number;
    limit?: number;
    offset?: number;
  } = {}
) {
  const db = await getSchoolDB(env, schoolCode);
  const {
    dateFrom,
    dateTo,
    classSubjectId,
    classSectionId,
    teacherId,
    limit = 50,
    offset = 0,
  } = filters;

  const whereClause = [];
  if (classSectionId)
    whereClause.push(
      eq(schoolAssignmentsSchema.classSectionId, classSectionId)
    );
  if (classSubjectId)
    whereClause.push(
      eq(schoolTeacherAssignmentsSchema.classSubjectId, classSubjectId)
    );
  if (teacherId)
    whereClause.push(eq(schoolTeacherAssignmentsSchema.teacherId, teacherId));
  if (dateFrom)
    whereClause.push(gte(schoolAssignmentsSchema.createdAt, dateFrom));
  if (dateTo) whereClause.push(lte(schoolAssignmentsSchema.createdAt, dateTo));

  const assignments = await db
    .select({
      id: schoolAssignmentsSchema.id,
      teacherAssignmentId: schoolAssignmentsSchema.teacherAssignmentId,
      classSectionId: schoolAssignmentsSchema.classSectionId,
      type: schoolAssignmentsSchema.type,
      title: schoolAssignmentsSchema.title,
      description: schoolAssignmentsSchema.description,
      dueDate: schoolAssignmentsSchema.dueDate,
      targetDate: schoolAssignmentsSchema.targetDate,
      maxMarks: schoolAssignmentsSchema.maxMarks,
      isMandatory: schoolAssignmentsSchema.isMandatory,
      enteredBy: schoolAssignmentsSchema.enteredBy,
      createdAt: schoolAssignmentsSchema.createdAt,
      updatedAt: schoolAssignmentsSchema.updatedAt,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      subjectName: schoolSubjectsSchema.name,
      teacherName: schoolUsersSchema.name,
    })
    .from(schoolAssignmentsSchema)
    .innerJoin(
      schoolTeacherAssignmentsSchema,
      eq(
        schoolAssignmentsSchema.teacherAssignmentId,
        schoolTeacherAssignmentsSchema.id
      )
    )
    // === FIXED JOIN CHAIN (new schema) ===
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionSubjectsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id)
    )
    .where(and(...whereClause))
    .orderBy(desc(schoolAssignmentsSchema.createdAt))
    .limit(limit)
    .offset(offset);

  return assignments as EnrichedAssignment[];
}

/**
 * GET SINGLE ASSIGNMENT BY ID
 *
 * Purpose: Used for edit form or detailed view. Returns full enriched assignment.
 */
export async function getAssignmentById(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const [assignment] = await db
    .select({
      id: schoolAssignmentsSchema.id,
      teacherAssignmentId: schoolAssignmentsSchema.teacherAssignmentId,
      classSectionId: schoolAssignmentsSchema.classSectionId,
      type: schoolAssignmentsSchema.type,
      title: schoolAssignmentsSchema.title,
      description: schoolAssignmentsSchema.description,
      dueDate: schoolAssignmentsSchema.dueDate,
      targetDate: schoolAssignmentsSchema.targetDate,
      maxMarks: schoolAssignmentsSchema.maxMarks,
      isMandatory: schoolAssignmentsSchema.isMandatory,
      enteredBy: schoolAssignmentsSchema.enteredBy,
      createdAt: schoolAssignmentsSchema.createdAt,
      updatedAt: schoolAssignmentsSchema.updatedAt,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      subjectName: schoolSubjectsSchema.name,
      teacherName: schoolUsersSchema.name,
    })
    .from(schoolAssignmentsSchema)
    .innerJoin(
      schoolTeacherAssignmentsSchema,
      eq(
        schoolAssignmentsSchema.teacherAssignmentId,
        schoolTeacherAssignmentsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionSubjectsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id)
    )
    .where(eq(schoolAssignmentsSchema.id, id));

  if (!assignment) throw new Error("Assignment not found");
  return assignment as EnrichedAssignment;
}

/**
 * GET STUDENT ASSIGNMENTS
 *
 * Purpose: Student/Parent view — shows all assignments relevant to the student with their personal submission status.
 */
export async function getStudentAssignments(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  filters: {
    studentId: number;
    dateFrom?: string;
    dateTo?: string;
    classSubjectId?: number;
  }
) {
  const db = await getSchoolDB(env, schoolCode);
  const { studentId, dateFrom, dateTo, classSubjectId } = filters;

  const where = [eq(schoolStudentEnrollmentsSchema.studentId, studentId)];
  if (classSubjectId)
    where.push(
      eq(schoolTeacherAssignmentsSchema.classSubjectId, classSubjectId)
    );
  if (dateFrom) where.push(gte(schoolAssignmentsSchema.createdAt, dateFrom));
  if (dateTo) where.push(lte(schoolAssignmentsSchema.createdAt, dateTo));

  const assignments = await db
    .select({
      id: schoolAssignmentsSchema.id,
      teacherAssignmentId: schoolAssignmentsSchema.teacherAssignmentId,
      classSectionId: schoolAssignmentsSchema.classSectionId,
      type: schoolAssignmentsSchema.type,
      title: schoolAssignmentsSchema.title,
      description: schoolAssignmentsSchema.description,
      dueDate: schoolAssignmentsSchema.dueDate,
      targetDate: schoolAssignmentsSchema.targetDate,
      maxMarks: schoolAssignmentsSchema.maxMarks,
      isMandatory: schoolAssignmentsSchema.isMandatory,
      enteredBy: schoolAssignmentsSchema.enteredBy,
      createdAt: schoolAssignmentsSchema.createdAt,
      updatedAt: schoolAssignmentsSchema.updatedAt,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      subjectName: schoolSubjectsSchema.name,
      teacherName: schoolUsersSchema.name,
      studentStatus: schoolAssignmentSubmissionsSchema.studentStatus,
      teacherStatus: schoolAssignmentSubmissionsSchema.teacherStatus,
      marksObtained: schoolAssignmentSubmissionsSchema.marksObtained,
      receivedAt: schoolAssignmentSubmissionsSchema.receivedAt,
    })
    .from(schoolAssignmentsSchema)
    .innerJoin(
      schoolTeacherAssignmentsSchema,
      eq(
        schoolAssignmentsSchema.teacherAssignmentId,
        schoolTeacherAssignmentsSchema.id
      )
    )
    // === FIXED JOIN CHAIN (new schema) ===
    .innerJoin(
      schoolClassSectionSubjectsSchema,
      eq(
        schoolTeacherAssignmentsSchema.classSubjectId,
        schoolClassSectionSubjectsSchema.id
      )
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolClassSectionSubjectsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .innerJoin(
      schoolSubjectsSchema,
      eq(schoolClassSectionSubjectsSchema.subjectId, schoolSubjectsSchema.id)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolTeacherAssignmentsSchema.teacherId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(schoolAssignmentsSchema.classSectionId, schoolClassSectionsSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .leftJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolAssignmentsSchema.classSectionId
      )
    )
    .leftJoin(
      schoolAssignmentSubmissionsSchema,
      and(
        eq(
          schoolAssignmentSubmissionsSchema.assignmentId,
          schoolAssignmentsSchema.id
        ),
        eq(
          schoolAssignmentSubmissionsSchema.enrollmentId,
          schoolStudentEnrollmentsSchema.id
        )
      )
    )
    .where(and(...where))
    .orderBy(desc(schoolAssignmentsSchema.createdAt));

  return assignments as (EnrichedAssignment & {
    studentStatus?: string;
    teacherStatus?: string;
    marksObtained?: number | null;
    receivedAt?: string;
  })[];
}

/**
 * UPDATE ASSIGNMENT
 *
 * Purpose: Allows teachers/principals to edit an existing assignment.
 */
export async function updateAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const existing = await db
    .select()
    .from(schoolAssignmentsSchema)
    .where(eq(schoolAssignmentsSchema.id, id))
    .get();
  if (!existing) throw new Error("Assignment not found");

  const [updated] = await db
    .update(schoolAssignmentsSchema)
    .set({ ...data, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schoolAssignmentsSchema.id, id))
    .returning();

  return { assignment: updated, message: "Assignment updated successfully" };
}

/**
 * DELETE ASSIGNMENT
 *
 * Purpose: Safe deletion with check that no submissions exist.
 */
export async function deleteAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const used = await db
    .select()
    .from(schoolAssignmentSubmissionsSchema)
    .where(eq(schoolAssignmentSubmissionsSchema.assignmentId, id))
    .limit(1)
    .get();

  if (used)
    throw new Error("Cannot delete assignment with existing submissions");

  const [deleted] = await db
    .delete(schoolAssignmentsSchema)
    .where(eq(schoolAssignmentsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Assignment not found");

  return { message: "Assignment deleted successfully" };
}

/**
 * STUDENT SUBMIT ASSIGNMENT (Mark as Done)
 *
 * Purpose: Student marks an assignment as completed. Auto-resolves enrollment using classSectionId.
 */
export async function studentSubmitAssignment(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { assignmentId: number },
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // Get assignment's classSectionId
  const assignment = await db
    .select({ classSectionId: schoolAssignmentsSchema.classSectionId })
    .from(schoolAssignmentsSchema)
    .where(eq(schoolAssignmentsSchema.id, data.assignmentId))
    .get();

  if (!assignment) throw new Error("Assignment not found");

  // Find student's active enrollment for this exact classSection
  const enrollment = await db
    .select({ id: schoolStudentEnrollmentsSchema.id })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          assignment.classSectionId
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!enrollment)
    throw new Error("No active enrollment found for this assignment");

  // Mark as done
  const [updated] = await db
    .update(schoolAssignmentSubmissionsSchema)
    .set({
      studentStatus: "MARKED_AS_DONE",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(schoolAssignmentSubmissionsSchema.assignmentId, data.assignmentId),
        eq(schoolAssignmentSubmissionsSchema.enrollmentId, enrollment.id)
      )
    )
    .returning();

  if (!updated) throw new Error("Submission record not found");

  return { message: "Marked as done successfully" };
}

/**
 * RECORD SUBMISSION (Teacher Bulk Update)
 *
 * Purpose: Teacher updates status/marks for multiple students on one assignment.
 */
export async function recordSubmission(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { assignmentId: number; submissions: any[] },
  enteredBy: number
) {
  const db = await getSchoolDB(env, schoolCode);

  console.log(
    `Saving ${data.submissions.length} rows for assignment ${data.assignmentId}`
  );

  return await db.transaction(async (tx) => {
    let recorded = 0;

    for (const sub of data.submissions) {
      await tx
        .update(schoolAssignmentSubmissionsSchema)
        .set({
          teacherStatus: sub.teacherStatus || "RECEIVED",
          studentStatus: sub.studentStatus || "MARKED_AS_DONE",
          receivedAt: sub.receivedAt || sql`CURRENT_DATE`,
          marksObtained: sub.marksObtained ?? null,
          remarks: sub.remarks || null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          enteredBy, // track who last edited
        })
        .where(
          and(
            eq(
              schoolAssignmentSubmissionsSchema.assignmentId,
              data.assignmentId
            ),
            eq(schoolAssignmentSubmissionsSchema.enrollmentId, sub.enrollmentId)
          )
        );

      recorded++;
    }

    return {
      message: `Updated ${recorded} submissions`,
      recorded,
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * GET SUBMISSIONS BY STUDENT
 *
 * Purpose: Shows submission history for a specific student (used by student/parent/teacher).
 */
export async function getSubmissionsByStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number,
  assignmentId?: number
) {
  const db = await getSchoolDB(env, schoolCode);

  const whereClause = [eq(schoolStudentEnrollmentsSchema.studentId, studentId)];
  if (assignmentId) {
    whereClause.push(
      eq(schoolAssignmentSubmissionsSchema.assignmentId, assignmentId)
    );
  }

  return await db
    .select({
      // Explicit columns from submissions (no spread!)
      id: schoolAssignmentSubmissionsSchema.id,
      assignmentId: schoolAssignmentSubmissionsSchema.assignmentId,
      enrollmentId: schoolAssignmentSubmissionsSchema.enrollmentId,

      studentStatus: schoolAssignmentSubmissionsSchema.studentStatus,
      teacherStatus: schoolAssignmentSubmissionsSchema.teacherStatus,
      receivedAt: schoolAssignmentSubmissionsSchema.receivedAt,

      marksObtained: schoolAssignmentSubmissionsSchema.marksObtained,
      remarks: schoolAssignmentSubmissionsSchema.remarks,
      enteredBy: schoolAssignmentSubmissionsSchema.enteredBy,
      createdAt: schoolAssignmentSubmissionsSchema.createdAt,
      updatedAt: schoolAssignmentSubmissionsSchema.updatedAt,

      // Join data for better frontend use
      studentName: schoolUsersSchema.name, // optional enrichment
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
    })
    .from(schoolAssignmentSubmissionsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAssignmentSubmissionsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .where(and(...whereClause));
}

/**
 * GET SUBMISSIONS REPORT (Teacher View)
 *
 * Purpose: Returns detailed submission report for one assignment with aggregates.
 * Used in teacher dashboard for grading overview.
 *
 * @param data.assignmentId - Required assignment ID
 * @returns report array + aggregates (totalStudents, completed, completionRate, avgMarks)
 */
export async function getSubmissionsReport(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const assignmentId = Number(data.assignmentId);
  if (isNaN(assignmentId) || assignmentId <= 0) {
    throw new Error("Invalid assignment ID");
  }

  const submissions = await db
    .select({
      enrollmentId: schoolAssignmentSubmissionsSchema.enrollmentId,
      studentStatus: schoolAssignmentSubmissionsSchema.studentStatus,
      teacherStatus: schoolAssignmentSubmissionsSchema.teacherStatus,
      receivedAt: schoolAssignmentSubmissionsSchema.receivedAt,
      marksObtained: schoolAssignmentSubmissionsSchema.marksObtained,
      remarks: schoolAssignmentSubmissionsSchema.remarks,
      studentName: schoolUsersSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
    })
    .from(schoolAssignmentSubmissionsSchema)
    .innerJoin(
      schoolStudentEnrollmentsSchema,
      eq(
        schoolAssignmentSubmissionsSchema.enrollmentId,
        schoolStudentEnrollmentsSchema.id
      )
    )
    .innerJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .innerJoin(
      schoolClassSectionsSchema,
      eq(
        schoolStudentEnrollmentsSchema.classSectionId,
        schoolClassSectionsSchema.id
      )
    )
    .innerJoin(
      schoolClassesSchema,
      eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
    )
    .innerJoin(
      schoolSectionsSchema,
      eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
    )
    .where(eq(schoolAssignmentSubmissionsSchema.assignmentId, assignmentId));

  const totalStudents = submissions.length;
  const completed = submissions.filter(
    (s) => s.teacherStatus === "GRADED"
  ).length;
  const avgMarks =
    submissions.reduce((sum, s) => sum + (s.marksObtained || 0), 0) /
      Math.max(totalStudents, 1) || 0;

  return {
    report: submissions,
    aggregates: {
      totalStudents,
      completed,
      completionRate:
        totalStudents > 0
          ? ((completed / totalStudents) * 100).toFixed(1)
          : "0",
      avgMarks: Math.round(avgMarks),
    },
  };
}
