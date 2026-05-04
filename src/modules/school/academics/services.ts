import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  schoolAcademicYearsSchema,
  schoolAttendancesSchema,
  schoolClassesSchema,
  schoolClassSectionMappingsSchema,
  schoolClassSectionsSchema,
  schoolExamMarksSchema,
  schoolFeePaymentsSchema,
  schoolFeeStructuresSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentsSchema,
  teachersSchema,
  UnenrollmentType,
  UnenrollmentTypeValue,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";

// ==================== Create Academic Year ====================
export async function createAcademicYear(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // Check no current year exists
    const existingCurrent = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (existingCurrent)
      throw new Error("A current academic year already exists");

    const [newYear] = await tx
      .insert(schoolAcademicYearsSchema)
      .values({
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        isCurrent: true, // Set as current
      })
      .returning();

    return {
      year: newYear,
      message: "Academic year created and set as current",
    };
  });
}

// ==================== Get Academic Years ====================
export async function getAcademicYears(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select()
    .from(schoolAcademicYearsSchema)
    .orderBy(schoolAcademicYearsSchema.startDate);
}

// ==================== Update Academic Year ====================
export async function updateAcademicYear(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  const [updated] = await db
    .update(schoolAcademicYearsSchema)
    .set(data)
    .where(eq(schoolAcademicYearsSchema.id, id))
    .returning();

  if (!updated) throw new Error("Academic year not found");

  return { year: updated, message: "Academic year updated" };
}

// ==================== Delete Academic Year ====================
export async function deleteAcademicYear(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // Guard: cannot delete current year
    const year = await tx
      .select({ isCurrent: schoolAcademicYearsSchema.isCurrent })
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.id, id))
      .get();

    if (!year) throw new Error("Academic year not found");
    if (year.isCurrent)
      throw new Error("Cannot delete the current academic year");

    // Guard: has enrollments
    const hasEnrollments = await tx
      .select({ id: schoolStudentEnrollmentsSchema.id })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.academicYearId, id))
      .limit(1)
      .get();

    if (hasEnrollments) {
      throw new Error("Cannot delete academic year with existing enrollments");
    }

    const [deleted] = await tx
      .delete(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.id, id))
      .returning();

    return { message: "Academic year deleted" };
  });
}

// ==================== MANUAL SINGLE STUDENT MOVE / PROMOTE / DEPROMOTE ====================
export async function moveStudentToNewClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const currentYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (!currentYear) throw new Error("No current academic year found");

    // 1. Find current active enrollment
    const currentEnrollment = await tx
      .select({
        id: schoolStudentEnrollmentsSchema.id,
        studentName: schoolUsersSchema.name,
        oldClassSectionId: schoolStudentEnrollmentsSchema.classSectionId,
        oldRollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      })
      .from(schoolStudentEnrollmentsSchema)
      .innerJoin(
        studentsSchema,
        eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
      )
      .innerJoin(
        schoolUsersSchema,
        eq(studentsSchema.userId, schoolUsersSchema.id)
      )
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, data.studentId),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get();

    if (!currentEnrollment)
      throw new Error("Student is not currently enrolled in active year");

    // 2. Check target class-section exists and has capacity
    const targetSection = await tx
      .select({ capacity: schoolClassSectionsSchema.capacity })
      .from(schoolClassSectionsSchema)
      .where(eq(schoolClassSectionsSchema.id, data.targetClassSectionId))
      .get();

    if (!targetSection) throw new Error("Target class-section does not exist");

    const currentCount = await tx.$count(
      schoolStudentEnrollmentsSchema,
      and(
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          data.targetClassSectionId
        ),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    );

    if (currentCount >= targetSection.capacity) {
      throw new Error("Target class-section is full");
    }

    // 3. Deactivate old enrollment
    await tx
      .update(schoolStudentEnrollmentsSchema)
      .set({ isActive: false })
      .where(eq(schoolStudentEnrollmentsSchema.id, currentEnrollment.id));

    // 4. Auto-generate roll number in new section
    let newRollNumber = data.targetRollNumber;
    if (!newRollNumber) {
      const existingRolls = await tx
        .select({ roll: schoolStudentEnrollmentsSchema.rollNumber })
        .from(schoolStudentEnrollmentsSchema)
        .where(
          eq(
            schoolStudentEnrollmentsSchema.classSectionId,
            data.targetClassSectionId
          )
        );

      const max = Math.max(
        0,
        ...existingRolls.map((r) => parseInt(r.roll || "0"))
      );
      newRollNumber = (max + 1).toString().padStart(3, "0");
    }

    // 5. Create new enrollment
    const [newEnrollment] = await tx
      .insert(schoolStudentEnrollmentsSchema)
      .values({
        studentId: data.studentId,
        academicYearId: currentYear.id,
        classSectionId: data.targetClassSectionId,
        rollNumber: newRollNumber,
        enrollmentDate: sql`CURRENT_DATE`,
        isActive: true,
      })
      .returning();

    // 6. Update student profile roll number
    await tx
      .update(studentsSchema)
      .set({ rollNumber: newRollNumber })
      .where(eq(studentsSchema.userId, data.studentId));

    return {
      message: "Student moved successfully",
      studentName: currentEnrollment.studentName,
      oldClassSectionId: currentEnrollment.oldClassSectionId,
      oldRollNumber: currentEnrollment.oldRollNumber,
      newEnrollment,
      notes: data.notes || "Manual move by admin",
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK PROMOTE STUDENTS  (production-grade, with global-mapping fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promotes a list of students to a new class-section in the CURRENT academic year.
 *
 * Modes:
 *   - useMapping: true  → resolve next section via year-specific then global mapping
 *   - targetClassSectionId set → all students go to that specific section
 */
export async function bulkPromoteStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    studentIds: number[];
    targetClassSectionId?: number | null;
    useMapping: boolean;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const currentYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (!currentYear) throw new Error("No current academic year found");

    const results: Array<{
      studentId: number;
      studentName: string;
      success: boolean;
      oldClassSection?: string;
      newClassSection?: string;
      error?: string;
    }> = [];

    for (const studentId of data.studentIds) {
      try {
        // 1. Current active enrollment
        const currentEnrollment = await tx
          .select({
            id: schoolStudentEnrollmentsSchema.id,
            studentName: schoolUsersSchema.name,
            oldClassSectionId: schoolStudentEnrollmentsSchema.classSectionId,
            oldRollNumber: schoolStudentEnrollmentsSchema.rollNumber,
            oldClassName: schoolClassesSchema.name,
            oldSectionName: schoolSectionsSchema.name,
          })
          .from(schoolStudentEnrollmentsSchema)
          .innerJoin(
            studentsSchema,
            eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
          )
          .innerJoin(
            schoolUsersSchema,
            eq(studentsSchema.userId, schoolUsersSchema.id)
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
          .where(
            and(
              eq(schoolStudentEnrollmentsSchema.studentId, studentId),
              eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
              eq(schoolStudentEnrollmentsSchema.isActive, true)
            )
          )
          .get();

        if (!currentEnrollment) {
          results.push({
            studentId,
            studentName: "Unknown",
            success: false,
            error: "Student not enrolled in current academic year",
          });
          continue;
        }

        // 2. Determine target class-section
        let targetClassSectionId = data.targetClassSectionId ?? null;

        if (data.useMapping && !targetClassSectionId) {
          // Use year-specific first, then global mapping
          targetClassSectionId = await resolveNextClassSectionInTx(
            tx,
            currentEnrollment.oldClassSectionId,
            currentYear.id
          );

          if (!targetClassSectionId) {
            results.push({
              studentId,
              studentName: currentEnrollment.studentName,
              success: false,
              error: `No mapping configured for ${currentEnrollment.oldClassName} - ${currentEnrollment.oldSectionName}. Please create a global or year-specific mapping first.`,
            });
            continue;
          }
        }

        if (!targetClassSectionId) {
          results.push({
            studentId,
            studentName: currentEnrollment.studentName,
            success: false,
            error: "No target class-section determined",
          });
          continue;
        }

        // 3. Check capacity
        const targetSection = await tx
          .select({
            capacity: schoolClassSectionsSchema.capacity,
            className: schoolClassesSchema.name,
            sectionName: schoolSectionsSchema.name,
          })
          .from(schoolClassSectionsSchema)
          .innerJoin(
            schoolClassesSchema,
            eq(schoolClassSectionsSchema.classId, schoolClassesSchema.id)
          )
          .innerJoin(
            schoolSectionsSchema,
            eq(schoolClassSectionsSchema.sectionId, schoolSectionsSchema.id)
          )
          .where(eq(schoolClassSectionsSchema.id, targetClassSectionId))
          .get();

        if (!targetSection) {
          results.push({
            studentId,
            studentName: currentEnrollment.studentName,
            success: false,
            error: "Target class-section not found",
          });
          continue;
        }

        const currentCount = await tx.$count(
          schoolStudentEnrollmentsSchema,
          and(
            eq(
              schoolStudentEnrollmentsSchema.classSectionId,
              targetClassSectionId
            ),
            eq(schoolStudentEnrollmentsSchema.isActive, true)
          )
        );

        if (currentCount >= targetSection.capacity) {
          results.push({
            studentId,
            studentName: currentEnrollment.studentName,
            success: false,
            error: `${targetSection.className} - ${targetSection.sectionName} is at full capacity`,
          });
          continue;
        }

        // 4. Deactivate old enrollment
        await tx
          .update(schoolStudentEnrollmentsSchema)
          .set({ isActive: false })
          .where(eq(schoolStudentEnrollmentsSchema.id, currentEnrollment.id));

        // 5. Auto roll number in new section
        const existingRolls = await tx
          .select({ roll: schoolStudentEnrollmentsSchema.rollNumber })
          .from(schoolStudentEnrollmentsSchema)
          .where(
            eq(
              schoolStudentEnrollmentsSchema.classSectionId,
              targetClassSectionId
            )
          );

        const max = Math.max(
          0,
          ...existingRolls.map((r: any) => parseInt(r.roll || "0"))
        );
        const newRollNumber = (max + 1).toString().padStart(3, "0");

        // 6. Create new enrollment
        await tx.insert(schoolStudentEnrollmentsSchema).values({
          studentId,
          academicYearId: currentYear.id,
          classSectionId: targetClassSectionId,
          rollNumber: newRollNumber,
          enrollmentDate: sql`CURRENT_DATE`,
          isActive: true,
        });

        // 7. Update student profile roll number
        await tx
          .update(studentsSchema)
          .set({ rollNumber: newRollNumber })
          .where(eq(studentsSchema.userId, studentId));

        results.push({
          studentId,
          studentName: currentEnrollment.studentName,
          success: true,
          oldClassSection: `${currentEnrollment.oldClassName} - ${currentEnrollment.oldSectionName}`,
          newClassSection: `${targetSection.className} - ${targetSection.sectionName}`,
        });
      } catch (err: any) {
        results.push({
          studentId,
          studentName: "Unknown",
          success: false,
          error: err.message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return {
      message: `Promoted ${successCount} student(s) successfully${
        failCount > 0 ? `, ${failCount} failed` : ""
      }`,
      successCount,
      failCount,
      results,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMOTE ALL STUDENTS TO NEXT YEAR  (also uses global mapping fallback)
// ─────────────────────────────────────────────────────────────────────────────

export async function promoteStudentsToNextYear(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const currentYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (!currentYear) throw new Error("No current academic year");

    const [startStr, endStr] = currentYear.name.split("-");
    const nextYearName = `${parseInt(startStr) + 1}-${parseInt(endStr) + 1}`;

    const [nextYear] = await tx
      .insert(schoolAcademicYearsSchema)
      .values({
        name: nextYearName,
        startDate: currentYear.endDate,
        endDate: currentYear.endDate.replace(/(\d{4})/g, (y: string) =>
          (parseInt(y) + 1).toString()
        ),
        isCurrent: true,
      })
      .returning();

    await tx
      .update(schoolAcademicYearsSchema)
      .set({ isCurrent: false })
      .where(eq(schoolAcademicYearsSchema.id, currentYear.id));

    const enrollments = await tx
      .select({
        studentId: schoolStudentEnrollmentsSchema.studentId,
        currentClassSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      );

    let promoted = 0;
    let unmapped = 0;

    for (const e of enrollments) {
      // Use updated resolver: year-specific then global
      const nextClassSectionId = await resolveNextClassSectionInTx(
        tx,
        e.currentClassSectionId,
        currentYear.id
      );

      const targetId = nextClassSectionId ?? e.currentClassSectionId;
      if (!nextClassSectionId) unmapped++;

      await tx.insert(schoolStudentEnrollmentsSchema).values({
        studentId: e.studentId,
        academicYearId: nextYear.id,
        classSectionId: targetId,
        isActive: true,
      });

      promoted++;
    }

    return {
      message: `Promoted ${promoted} students (${unmapped} without explicit mapping, kept in same section)`,
      newYear: nextYear,
      promoted,
      unmapped,
    };
  });
}

/**
 * Auto Roll Number + ENROLL STUDENT
 *
 * @param env
 * @param schoolCode
 * @param data
 * @returns
 */
export async function enrollStudentInClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    studentId: number;
    classSectionId: number;
    rollNumber?: string | null;
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  // ── Pre-flight: check re-enrollment eligibility ──────────────────────
  // Must happen BEFORE the transaction so we can throw a clear error
  // without starting a transaction we'll immediately abort.
  const eligibility = await checkReEnrollmentEligibility(
    env,
    schoolCode,
    data.studentId
  );

  if (!eligibility.canReenroll) {
    throw new Error(
      eligibility.reason ??
        "This student is not eligible for enrollment. Please check their account status."
    );
  }

  return await db.transaction(async (tx) => {
    const currentYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (!currentYear) throw new Error("No current academic year");

    // Guard: already enrolled this year
    const existing = await tx
      .select({ id: schoolStudentEnrollmentsSchema.id })
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, data.studentId),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get();

    if (existing) throw new Error("Student already enrolled this year");

    // Guard: class-section capacity
    const targetSection = await tx
      .select({ capacity: schoolClassSectionsSchema.capacity })
      .from(schoolClassSectionsSchema)
      .where(eq(schoolClassSectionsSchema.id, data.classSectionId))
      .get();

    if (!targetSection) throw new Error("Class-section not found");

    const currentCount = await tx.$count(
      schoolStudentEnrollmentsSchema,
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    );

    if (currentCount >= targetSection.capacity)
      throw new Error("Class-section is at full capacity");

    // Auto roll number
    let rollNumber = data.rollNumber;
    if (!rollNumber) {
      const existingRolls = await tx
        .select({ roll: schoolStudentEnrollmentsSchema.rollNumber })
        .from(schoolStudentEnrollmentsSchema)
        .where(
          eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
        );

      const max = Math.max(
        0,
        ...existingRolls.map((r) => parseInt(r.roll || "0"))
      );
      rollNumber = (max + 1).toString().padStart(3, "0");
    }

    const [newEnrollment] = await tx
      .insert(schoolStudentEnrollmentsSchema)
      .values({
        studentId: data.studentId,
        academicYearId: currentYear.id,
        classSectionId: data.classSectionId,
        rollNumber,
        isActive: true,
      })
      .returning();

    await tx
      .update(studentsSchema)
      .set({ rollNumber })
      .where(eq(studentsSchema.userId, data.studentId));

    return {
      enrollment: newEnrollment,
      rollNumber,
      message: "Student enrolled successfully",
    };
  });
}

// ==================== PRE-FLIGHT CHECK (called before showing unenrollment form) ====================
/**
 * Returns everything the frontend needs to show the unenrollment confirmation modal:
 *   - Current enrollment details
 *   - Pending fee summary (warning, not a block)
 *   - Historical record counts (attendance, submissions, marks)
 *   - Whether the student has a linked parent
 *
 * This is a READ-ONLY operation — it changes nothing.
 */
export async function getEnrollmentStatus(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number
) {
  const db = await getSchoolDB(env, schoolCode);

  // 1. Current active enrollment
  const activeEnrollment = await db
    .select({
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      studentName: schoolUsersSchema.name,
      studentEmail: schoolUsersSchema.email,
      isUserActive: schoolUsersSchema.isActive,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
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
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .get();

  if (!activeEnrollment) {
    return {
      isEnrolled: false,
      student: null,
      enrollment: null,
      pendingFees: null,
      recordCounts: null,
    };
  }

  // 2. Attendance count for this enrollment
  const attendanceCount = await db
    .select({ count: count() })
    .from(schoolAttendancesSchema)
    .where(
      eq(schoolAttendancesSchema.enrollmentId, activeEnrollment.enrollmentId)
    )
    .get();

  // 3. Exam marks count
  const marksCount = await db
    .select({ count: count() })
    .from(schoolExamMarksSchema)
    .where(
      eq(schoolExamMarksSchema.enrollmentId, activeEnrollment.enrollmentId)
    )
    .get();

  // 4. Fee structures applicable to this class-section + academic year
  const feeStructures = await db
    .select({
      id: schoolFeeStructuresSchema.id,
      feeType: schoolFeeStructuresSchema.feeType,
      amount: schoolFeeStructuresSchema.amount,
      dueDate: schoolFeeStructuresSchema.dueDate,
      isMandatory: schoolFeeStructuresSchema.isMandatory,
    })
    .from(schoolFeeStructuresSchema)
    .where(
      and(
        eq(
          schoolFeeStructuresSchema.classSectionId,
          activeEnrollment.classSectionId
        ),
        eq(
          schoolFeeStructuresSchema.academicYearId,
          activeEnrollment.academicYearId
        )
      )
    )
    .all();

  // 5. Fee payments already made for this enrollment
  const feePayments = await db
    .select({
      feeStructureId: schoolFeePaymentsSchema.feeStructureId,
      amountPaid: schoolFeePaymentsSchema.amountPaid,
      isVoid: schoolFeePaymentsSchema.isVoid,
    })
    .from(schoolFeePaymentsSchema)
    .where(
      and(
        eq(schoolFeePaymentsSchema.enrollmentId, activeEnrollment.enrollmentId),
        eq(schoolFeePaymentsSchema.isVoid, false)
      )
    )
    .all();

  // 6. Compute pending fee summary
  const totalDue = feeStructures
    .filter((f) => f.isMandatory)
    .reduce((sum, f) => sum + f.amount, 0);

  const totalPaid = feePayments.reduce((sum, p) => sum + p.amountPaid, 0);

  const pendingAmount = Math.max(0, totalDue - totalPaid);

  // 7. Enrollment history — how many inactive enrollments exist (transfer/unenroll history)
  const historyCount = await db
    .select({ count: count() })
    .from(schoolStudentEnrollmentsSchema)
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, studentId),
        eq(schoolStudentEnrollmentsSchema.isActive, false)
      )
    )
    .get();

  return {
    isEnrolled: true,
    student: {
      id: studentId,
      name: activeEnrollment.studentName,
      email: activeEnrollment.studentEmail,
      isUserActive: activeEnrollment.isUserActive,
    },
    enrollment: {
      id: activeEnrollment.enrollmentId,
      className: activeEnrollment.className,
      sectionName: activeEnrollment.sectionName,
      rollNumber: activeEnrollment.rollNumber,
      enrollmentDate: activeEnrollment.enrollmentDate,
      classSectionId: activeEnrollment.classSectionId,
    },
    pendingFees: {
      totalDue,
      totalPaid,
      pendingAmount,
      hasPendingFees: pendingAmount > 0,
      mandatoryFeeCount: feeStructures.filter((f) => f.isMandatory).length,
    },
    recordCounts: {
      attendanceRecords: attendanceCount?.count ?? 0,
      examMarkRecords: marksCount?.count ?? 0,
      enrollmentHistory: historyCount?.count ?? 0,
    },
  };
}

// ==================== UNENROLL STUDENT ====================
/**
 * PRODUCTION-GRADE UNENROLLMENT
 *
 * What this does atomically in a single transaction:
 *  1. Validates the student has an active enrollment
 *  2. Updates the enrollment row: isActive=false + all 4 audit columns
 *  3. If PERMANENT: clears rollNumber from students profile + deactivates school_users account
 *  4. Returns a complete audit summary
 *
 * What this does NOT do (by design):
 *  - Does NOT delete any records (attendance, fees, marks, submissions)
 *  - Does NOT delete the user account (even for PERMANENT — deactivate only)
 *  - Does NOT block if there are pending fees (frontend shows a warning, admin acknowledges)
 */
export async function unenrollStudent(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: {
    studentId: number;
    unenrollmentType: UnenrollmentTypeValue;
    reason: string;
    performedBy: number; // userId of the admin/staff doing the action
    acknowledgePendingFees?: boolean; // must be true if hasPendingFees is true
  }
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // ── 1. Find current active enrollment ──────────────────────────────────
    const activeEnrollment = await tx
      .select({
        id: schoolStudentEnrollmentsSchema.id,
        studentName: schoolUsersSchema.name,
        studentEmail: schoolUsersSchema.email,
        className: schoolClassesSchema.name,
        sectionName: schoolSectionsSchema.name,
        rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
        classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
        academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      })
      .from(schoolStudentEnrollmentsSchema)
      .innerJoin(
        studentsSchema,
        eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
      )
      .innerJoin(
        schoolUsersSchema,
        eq(studentsSchema.userId, schoolUsersSchema.id)
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
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, data.studentId),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .get();

    if (!activeEnrollment) {
      throw new Error(
        "Student does not have an active enrollment in the current year"
      );
    }

    // ── 2. Validate reason is not empty ────────────────────────────────────
    const reason = data.reason?.trim();
    if (!reason || reason.length < 5) {
      throw new Error("A reason of at least 5 characters is required");
    }
    if (reason.length > 500) {
      throw new Error("Reason cannot exceed 500 characters");
    }

    const now = new Date().toISOString();

    // ── 3. Update enrollment record with full audit trail ──────────────────
    await tx
      .update(schoolStudentEnrollmentsSchema)
      .set({
        isActive: false,
        unenrollmentType: data.unenrollmentType,
        unenrollmentReason: reason,
        unenrolledAt: now,
        unenrolledBy: data.performedBy,
      })
      .where(eq(schoolStudentEnrollmentsSchema.id, activeEnrollment.id));

    // ── 4. PERMANENT unenrollment: deactivate user account + clear roll no ──
    if (data.unenrollmentType === UnenrollmentType.PERMANENT) {
      // Clear roll number from student profile (roll is tied to active enrollment)
      await tx
        .update(studentsSchema)
        .set({ rollNumber: "" })
        .where(eq(studentsSchema.userId, data.studentId));

      // Deactivate the user account (student can no longer log in)
      await tx
        .update(schoolUsersSchema)
        .set({
          isActive: false,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(schoolUsersSchema.id, data.studentId));
    }

    // ── 5. TEMPORARY unenrollment: clear roll number only (seat freed) ─────
    // For temporary, we still clear the roll number so the slot can be used
    // by someone else during the leave period. It will be re-assigned on re-enrollment.
    if (data.unenrollmentType === UnenrollmentType.TEMPORARY) {
      await tx
        .update(studentsSchema)
        .set({ rollNumber: "" })
        .where(eq(studentsSchema.userId, data.studentId));
    }

    // ── 6. Return complete audit summary ────────────────────────────────────
    return {
      success: true,
      message: buildSuccessMessage(
        activeEnrollment.studentName,
        data.unenrollmentType,
        activeEnrollment.className,
        activeEnrollment.sectionName
      ),
      audit: {
        studentId: data.studentId,
        studentName: activeEnrollment.studentName,
        enrollmentId: activeEnrollment.id,
        fromClass: `${activeEnrollment.className} — ${activeEnrollment.sectionName}`,
        fromRollNumber: activeEnrollment.rollNumber,
        unenrollmentType: data.unenrollmentType,
        reason,
        performedAt: now,
        performedBy: data.performedBy,
        userAccountDeactivated:
          data.unenrollmentType === UnenrollmentType.PERMANENT,
      },
    };
  });
}

// ==================== RE-ENROLL STUDENT (update existing guard) ====================
/**
 * Checks if a permanently unenrolled student is trying to be re-enrolled.
 * Call this in enrollStudentInClassSection before the existing "already enrolled" guard.
 *
 * Returns: { canReenroll: boolean, reason?: string }
 */
export async function checkReEnrollmentEligibility(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  studentId: number
): Promise<{
  canReenroll: boolean;
  reason?: string;
  requiresActivation?: boolean;
}> {
  const db = await getSchoolDB(env, schoolCode);

  // Check if the user account is active
  const user = await db
    .select({ isActive: schoolUsersSchema.isActive })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.id, studentId))
    .get();

  if (!user) {
    return { canReenroll: false, reason: "Student user account not found" };
  }

  if (!user.isActive) {
    return {
      canReenroll: false,
      reason:
        "This student was permanently unenrolled and their account is deactivated. Please reactivate their account first before re-enrolling.",
      requiresActivation: true,
    };
  }

  // Check most recent enrollment to see if it was a PERMANENT unenrollment
  // even if the account is somehow still active (edge case protection)
  const lastEnrollment = await db
    .select({
      isActive: schoolStudentEnrollmentsSchema.isActive,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
    })
    .from(schoolStudentEnrollmentsSchema)
    .where(eq(schoolStudentEnrollmentsSchema.studentId, studentId))
    .orderBy(sql`${schoolStudentEnrollmentsSchema.id} DESC`)
    .limit(1)
    .get();

  if (
    lastEnrollment &&
    !lastEnrollment.isActive &&
    lastEnrollment.unenrollmentType === UnenrollmentType.PERMANENT
  ) {
    if (user.isActive) {
      // Account is active but was permanently unenrolled — allow with note
      return { canReenroll: true };
    }
  }

  return { canReenroll: true };
}

// ── Helper ────────────────────────────────────────────────────────────────────
function buildSuccessMessage(
  studentName: string,
  type: UnenrollmentTypeValue,
  className: string,
  sectionName: string
): string {
  switch (type) {
    case UnenrollmentType.PERMANENT:
      return `${studentName} has been permanently unenrolled from ${className} — ${sectionName}. Their account has been deactivated.`;
    case UnenrollmentType.TEMPORARY:
      return `${studentName} has been temporarily unenrolled from ${className} — ${sectionName}. They can be re-enrolled when ready.`;
    default:
      return `${studentName} has been unenrolled from ${className} — ${sectionName}.`;
  }
}

// ==================== Get Enrollments ====================
export async function getEnrollments(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolStudentEnrollmentsSchema.id,
      studentId: schoolStudentEnrollmentsSchema.studentId,
      studentName: schoolUsersSchema.name,
      studentEmail: schoolUsersSchema.email,
      academicYearId: schoolStudentEnrollmentsSchema.academicYearId,
      classSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      enrollmentDate: schoolStudentEnrollmentsSchema.enrollmentDate,
      isActive: schoolStudentEnrollmentsSchema.isActive,
    })
    .from(schoolStudentEnrollmentsSchema)
    .innerJoin(
      studentsSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
    )
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
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
    .where(eq(schoolStudentEnrollmentsSchema.isActive, true))
    .orderBy(schoolUsersSchema.name);
}

/**
 * BACKEND UPDATE — academics/services.ts
 *
 * Replace the existing getUnenrolledStudents() function with this version.
 * It adds enrollStudentStatus ('NEW' | 'TEMPORARILY_UNENROLLED') plus
 * unenrollment details (reason, date, last class) for TEMPORARILY_UNENROLLED students.
 *
 * The function now does two queries:
 *   1. The original query: active students not enrolled in the current year
 *   2. For each student, check if their most recent enrollment was a TEMPORARY unenrollment
 *      to classify them and fetch the reason/class details.
 */

export async function getUnenrolledStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  console.log("[getUnenrolledStudents] Step 1: fetching current year");

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

    if (!currentYear) {
      // Throw a coded error so the route handler can return the right HTTP status
      throw new Error("NO_ACADEMIC_YEAR");
    }

  console.log(
    "[getUnenrolledStudents] Current year:",
    currentYear.id,
    currentYear.name
  );

  console.log("[getUnenrolledStudents] Step 2: fetching unenrolled students");
  let unenrolledStudents: any[] = [];
  try {
    unenrolledStudents = await db
      .select({
        id: schoolUsersSchema.id,
        name: schoolUsersSchema.name,
        email: schoolUsersSchema.email,
        phone: schoolUsersSchema.phone,
        gender: schoolUsersSchema.gender,
        dateOfBirth: schoolUsersSchema.dateOfBirth,
        bloodGroup: schoolUsersSchema.bloodGroup,
        avatarUrl: schoolUsersSchema.avatarUrl,
        admissionDate: studentsSchema.admissionDate,
      })
      .from(schoolUsersSchema)
      .innerJoin(
        studentsSchema,
        eq(schoolUsersSchema.id, studentsSchema.userId)
      )
      .leftJoin(
        schoolStudentEnrollmentsSchema,
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      )
      .where(
        and(
          isNull(schoolStudentEnrollmentsSchema.id),
          eq(schoolUsersSchema.isActive, true)
        )
      )
      .orderBy(schoolUsersSchema.name)
      .all();
    console.log(
      "[getUnenrolledStudents] Unenrolled count:",
      unenrolledStudents.length
    );
  } catch (err: any) {
    console.error(
      "[getUnenrolledStudents] FAILED at Step 2 (unenrolled query):",
      err.message,
      err
    );
    throw err;
  }

  if (unenrolledStudents.length === 0) return [];

  const studentIds = unenrolledStudents.map((s) => s.id);
  console.log("[getUnenrolledStudents] Student IDs:", studentIds);

  console.log(
    "[getUnenrolledStudents] Step 3: fetching last enrollments batch"
  );
  let allLastEnrollments: any[] = [];
  try {
    allLastEnrollments = await db
      .select({
        studentId: schoolStudentEnrollmentsSchema.studentId,
        enrollmentId: schoolStudentEnrollmentsSchema.id,
        unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
        unenrollmentReason: schoolStudentEnrollmentsSchema.unenrollmentReason,
        unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
        className: schoolClassesSchema.name,
        sectionName: schoolSectionsSchema.name,
        rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      })
      .from(schoolStudentEnrollmentsSchema)
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
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.isActive, false),
          sql`${schoolStudentEnrollmentsSchema.studentId} IN (${sql.raw(
            studentIds.join(", ")
          )})`
        )
      )
      .orderBy(sql`${schoolStudentEnrollmentsSchema.id} DESC`)
      .all();
    console.log(
      "[getUnenrolledStudents] Last enrollments fetched:",
      allLastEnrollments.length
    );
  } catch (err: any) {
    console.error(
      "[getUnenrolledStudents] FAILED at Step 3 (last enrollments batch):",
      err.message,
      err
    );
    // Step 3 failing is non-fatal — students just all get status "NEW"
    // Comment the throw below and uncomment the empty array fallback to test
    // allLastEnrollments = [];
    throw err;
  }

  const lastEnrollmentMap = new Map<
    number,
    (typeof allLastEnrollments)[number]
  >();
  for (const e of allLastEnrollments) {
    if (!lastEnrollmentMap.has(e.studentId)) {
      lastEnrollmentMap.set(e.studentId, e);
    }
  }

  console.log("[getUnenrolledStudents] Step 4: merging and returning");
  return unenrolledStudents.map((student) => {
    const last = lastEnrollmentMap.get(student.id) ?? null;
    const isTemp = last?.unenrollmentType === "TEMPORARY";
    return {
      ...student,
      enrollStudentStatus: isTemp ? "TEMPORARILY_UNENROLLED" : "NEW",
      lastClassName: isTemp ? last?.className ?? null : null,
      lastSectionName: isTemp ? last?.sectionName ?? null : null,
      lastRollNumber: isTemp ? last?.rollNumber ?? null : null,
      unenrollmentReason: isTemp ? last?.unenrollmentReason ?? null : null,
      unenrolledAt: isTemp ? last?.unenrolledAt ?? null : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// 2. NEW: getPermanentlyUnenrolledStudents
//    Called by the new backend route to power the "Unenrolled" tab.
//    Returns students who were PERMANENTLY unenrolled (isActive = false)
//    along with their last enrollment details for display.
// ─────────────────────────────────────────────────────────────────────

export async function getPermanentlyUnenrolledStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) {
    throw new Error("NO_ACADEMIC_YEAR");
  }

  const deactivatedStudents = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      phone: schoolUsersSchema.phone,
      gender: schoolUsersSchema.gender,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      bloodGroup: schoolUsersSchema.bloodGroup,
      avatarUrl: schoolUsersSchema.avatarUrl,
      isActive: schoolUsersSchema.isActive,
      admissionDate: studentsSchema.admissionDate,
    })
    .from(studentsSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(studentsSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(schoolUsersSchema.isActive, false))
    .orderBy(schoolUsersSchema.name)
    .all();

  if (deactivatedStudents.length === 0) return [];

  const studentIds = deactivatedStudents.map((s) => s.id);

  // Single batch query — same pattern as getUnenrolledStudents
  const allLastEnrollments = await db
    .select({
      studentId: schoolStudentEnrollmentsSchema.studentId,
      enrollmentId: schoolStudentEnrollmentsSchema.id,
      className: schoolClassesSchema.name,
      sectionName: schoolSectionsSchema.name,
      rollNumber: schoolStudentEnrollmentsSchema.rollNumber,
      unenrollmentType: schoolStudentEnrollmentsSchema.unenrollmentType,
      unenrollmentReason: schoolStudentEnrollmentsSchema.unenrollmentReason,
      unenrolledAt: schoolStudentEnrollmentsSchema.unenrolledAt,
    })
    .from(schoolStudentEnrollmentsSchema)
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
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.isActive, false),
        sql`${schoolStudentEnrollmentsSchema.studentId} IN (${sql.raw(
          studentIds.join(", ")
        )})`
      )
    )
    .orderBy(sql`${schoolStudentEnrollmentsSchema.id} DESC`)
    .all();

  const lastEnrollmentMap = new Map<
    number,
    (typeof allLastEnrollments)[number]
  >();
  for (const e of allLastEnrollments) {
    if (!lastEnrollmentMap.has(e.studentId)) {
      lastEnrollmentMap.set(e.studentId, e);
    }
  }

  return deactivatedStudents.map((student) => {
    const last = lastEnrollmentMap.get(student.id) ?? null;
    return {
      ...student,
      lastClassName: last?.className ?? null,
      lastSectionName: last?.sectionName ?? null,
      lastRollNumber: last?.rollNumber ?? null,
      unenrollmentType: last?.unenrollmentType ?? "PERMANENT",
      unenrollmentReason: last?.unenrollmentReason ?? null,
      unenrolledAt: last?.unenrolledAt ?? null,
      lastEnrollmentId: last?.enrollmentId ?? null,
    };
  });
}

// ==================== Bulk Assign Roll Numbers ====================
export async function assignRollNumbers(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: { classSectionId: number; orderBy: "name" | "admissionDate" }
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    const currentYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.isCurrent, true))
      .get();

    if (!currentYear) throw new Error("No current academic year");

    const enrollments = await tx
      .select({
        enrollmentId: schoolStudentEnrollmentsSchema.id,
        studentId: schoolStudentEnrollmentsSchema.studentId,
        studentName: schoolUsersSchema.name,
        admissionDate: studentsSchema.admissionDate,
      })
      .from(schoolStudentEnrollmentsSchema)
      .innerJoin(
        studentsSchema,
        eq(schoolStudentEnrollmentsSchema.studentId, studentsSchema.userId)
      )
      .innerJoin(
        schoolUsersSchema,
        eq(schoolUsersSchema.id, studentsSchema.userId)
      )
      .where(
        and(
          eq(
            schoolStudentEnrollmentsSchema.classSectionId,
            data.classSectionId
          ),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id),
          eq(schoolStudentEnrollmentsSchema.isActive, true)
        )
      );

    const sorted = [...enrollments].sort((a, b) => {
      if (data.orderBy === "name")
        return a.studentName.localeCompare(b.studentName);
      return (a.admissionDate || "").localeCompare(b.admissionDate || "");
    });

    let counter = 1;
    for (const e of sorted) {
      const newRoll = counter.toString().padStart(3, "0");
      await tx
        .update(schoolStudentEnrollmentsSchema)
        .set({ rollNumber: newRoll })
        .where(eq(schoolStudentEnrollmentsSchema.id, e.enrollmentId));
      await tx
        .update(studentsSchema)
        .set({ rollNumber: newRoll })
        .where(eq(studentsSchema.userId, e.studentId));
      counter++;
    }

    return {
      message: `Assigned roll numbers to ${sorted.length} students`,
      orderBy: data.orderBy,
      count: sorted.length,
    };
  });
}

// ==================== Get Teachers ====================
export async function getTeachers(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      qualification: teachersSchema.qualification,
      experienceYears: teachersSchema.experienceYears,
      specialization: teachersSchema.specialization,
    })
    .from(teachersSchema)
    .innerJoin(
      schoolUsersSchema,
      eq(teachersSchema.userId, schoolUsersSchema.id)
    )
    .where(eq(schoolUsersSchema.isActive, true))
    .orderBy(schoolUsersSchema.name);
}

export async function activateAcademicYear(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  id: number
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db.transaction(async (tx) => {
    // 1. Verify target year exists
    const targetYear = await tx
      .select()
      .from(schoolAcademicYearsSchema)
      .where(eq(schoolAcademicYearsSchema.id, id))
      .get();

    if (!targetYear) throw new Error("Academic year not found");

    if (targetYear.isCurrent) {
      throw new Error("This academic year is already active");
    }

    // 2. Deactivate ALL years (safe — only one should be active, but we reset all)
    await tx.update(schoolAcademicYearsSchema).set({ isCurrent: false });

    // 3. Activate the requested year
    const [updated] = await tx
      .update(schoolAcademicYearsSchema)
      .set({ isCurrent: true })
      .where(eq(schoolAcademicYearsSchema.id, id))
      .returning();

    return {
      year: updated,
      message: `"${updated.name}" is now the active academic year`,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING RESOLUTION HELPER (inline — avoids cross-module import)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves next class-section for a given current class-section.
 *
 * Priority:
 *   1. Year-specific mapping for currentAcademicYearId
 *   2. Global mapping (academicYearId IS NULL)
 *   3. null — no mapping found
 */
async function resolveNextClassSectionInTx(
  tx: any,
  currentClassSectionId: number,
  currentAcademicYearId: number
): Promise<number | null> {
  // 1. Year-specific
  const yearSpecific = await tx
    .select({ nextId: schoolClassSectionMappingsSchema.nextClassSectionId })
    .from(schoolClassSectionMappingsSchema)
    .where(
      and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          currentClassSectionId
        ),
        eq(
          schoolClassSectionMappingsSchema.academicYearId,
          currentAcademicYearId
        )
      )
    )
    .get();

  if (yearSpecific) return yearSpecific.nextId;

  // 2. Global
  const global = await tx
    .select({ nextId: schoolClassSectionMappingsSchema.nextClassSectionId })
    .from(schoolClassSectionMappingsSchema)
    .where(
      and(
        eq(
          schoolClassSectionMappingsSchema.currentClassSectionId,
          currentClassSectionId
        ),
        isNull(schoolClassSectionMappingsSchema.academicYearId)
      )
    )
    .get();

  return global?.nextId ?? null;
}
