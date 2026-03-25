import { getSchoolDB } from "../../../db/school-client";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  schoolAcademicYearsSchema,
  schoolClassesSchema,
  schoolClassSectionMappingsSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentsSchema,
  teachersSchema,
} from "../../../db/schemas/school";
import { SchoolEnv } from "../../../types/common-types";
import { alias } from "drizzle-orm/sqlite-core";

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

  const [deleted] = await db
    .delete(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.id, id))
    .returning();

  if (!deleted) throw new Error("Academic year not found");

  return { message: "Academic year deleted" };
}

// ==================== MANUAL SINGLE STUDENT MOVE / PROMOTE / DEPROMOTE ====================
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

    // FIXED: Use Drizzle's built-in $count (type-safe + clean)
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

// ==================== Promote Students to Next Year ====================
// ==================== Promote Students (Improved Logic) ====================
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

    // Create next year
    const nextYearName = `${parseInt(currentYear.name.split("-")[0]) + 1}-${
      parseInt(currentYear.name.split("-")[1]) + 1
    }`;
    const [nextYear] = await tx
      .insert(schoolAcademicYearsSchema)
      .values({
        name: nextYearName,
        startDate: currentYear.endDate,
        endDate: currentYear.endDate.replace(/\d{4}/g, (y) =>
          (parseInt(y) + 1).toString()
        ),
        isCurrent: true,
      })
      .returning();

    await tx
      .update(schoolAcademicYearsSchema)
      .set({ isCurrent: false })
      .where(eq(schoolAcademicYearsSchema.id, currentYear.id));

    // Get current enrollments + their class sections
    const enrollments = await tx
      .select({
        studentId: schoolStudentEnrollmentsSchema.studentId,
        currentClassSectionId: schoolStudentEnrollmentsSchema.classSectionId,
      })
      .from(schoolStudentEnrollmentsSchema)
      .where(eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id));

    let promoted = 0;
    let unmapped = 0;

    for (const e of enrollments) {
      // Smart lookup: 1. Year-specific → 2. Global → 3. Same section
      let mapping = await tx
        .select({ nextId: schoolClassSectionMappingsSchema.nextClassSectionId })
        .from(schoolClassSectionMappingsSchema)
        .where(
          and(
            eq(
              schoolClassSectionMappingsSchema.currentClassSectionId,
              e.currentClassSectionId
            ),
            eq(schoolClassSectionMappingsSchema.academicYearId, currentYear.id) // year-specific first
          )
        )
        .get();

      if (!mapping) {
        // Fallback to global mapping
        mapping = await tx
          .select({
            nextId: schoolClassSectionMappingsSchema.nextClassSectionId,
          })
          .from(schoolClassSectionMappingsSchema)
          .where(
            and(
              eq(
                schoolClassSectionMappingsSchema.currentClassSectionId,
                e.currentClassSectionId
              ),
              isNull(schoolClassSectionMappingsSchema.academicYearId)
            )
          )
          .get();
      }

      const nextClassSectionId = mapping?.nextId ?? e.currentClassSectionId;
      if (!mapping) unmapped++;

      await tx.insert(schoolStudentEnrollmentsSchema).values({
        studentId: e.studentId,
        academicYearId: nextYear.id,
        classSectionId: nextClassSectionId,
      });

      promoted++;
    }

    return {
      message: `Promoted ${promoted} students (${unmapped} without explicit mapping)`,
      newYear: nextYear,
    };
  });
}

// ==================== Auto Roll Number + Enroll ====================
// ==================== Enroll Student (NOW USING classSectionId) ====================
export async function enrollStudentInClass(
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

    if (!currentYear) throw new Error("No current academic year");

    // Duplicate check
    const existing = await tx
      .select()
      .from(schoolStudentEnrollmentsSchema)
      .where(
        and(
          eq(schoolStudentEnrollmentsSchema.studentId, data.studentId),
          eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id)
        )
      )
      .get();

    if (existing) throw new Error("Student already enrolled this year");

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

// ==================== Get Enrollments ====================
// ==================== Get Enrollments (Fixed Joins) ====================
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

// ==================== Get Unenrolled Students (for nice UX) ====================
export async function getUnenrolledStudents(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  const currentYear = await db
    .select()
    .from(schoolAcademicYearsSchema)
    .where(eq(schoolAcademicYearsSchema.isCurrent, true))
    .get();

  if (!currentYear) throw new Error("No current academic year found");

  return await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      email: schoolUsersSchema.email,
      dateOfBirth: schoolUsersSchema.dateOfBirth,
      admissionDate: studentsSchema.admissionDate,
    })
    .from(schoolUsersSchema)
    .innerJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId))
    .leftJoin(
      schoolStudentEnrollmentsSchema,
      and(
        eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id),
        eq(schoolStudentEnrollmentsSchema.academicYearId, currentYear.id)
      )
    )
    .where(isNull(schoolStudentEnrollmentsSchema.id)) // ← FIXED: use isNull
    .orderBy(schoolUsersSchema.name);
}

// ==================== Bulk Assign Roll Numbers (New Endpoint) ====================
export async function assignRollNumbers(
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

    if (!currentYear) throw new Error("No current academic year");

    // Get enrollments + student name for sorting
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
        eq(schoolStudentEnrollmentsSchema.classSectionId, data.classSectionId)
      );

    // Sort
    const sorted = enrollments.sort((a, b) => {
      if (data.orderBy === "name")
        return a.studentName.localeCompare(b.studentName);
      return (a.admissionDate || "").localeCompare(b.admissionDate || "");
    });

    // Assign new rolls
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
    .from(schoolUsersSchema)
    .innerJoin(teachersSchema, eq(schoolUsersSchema.id, teachersSchema.userId))
    .orderBy(schoolUsersSchema.name);
}
