import { and, eq, sql } from "drizzle-orm";
import {
  schoolClassesSchema,
  schoolClassSectionsSchema,
  schoolSectionsSchema,
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
} from "../../../../db/schemas/school";
import { getSchoolDB } from "../../../../db/school-client";
import { SchoolEnv } from "../../../../types/common-types";

export async function createClassSection(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  data: any
) {
  const db = await getSchoolDB(env, schoolCode);

  // Prevent duplicate combination
  const existing = await db
    .select()
    .from(schoolClassSectionsSchema)
    .where(
      and(
        eq(schoolClassSectionsSchema.classId, data.classId),
        eq(schoolClassSectionsSchema.sectionId, data.sectionId)
      )
    )
    .get();

  if (existing)
    throw new Error("This class-section combination already exists");

  const [newSection] = await db
    .insert(schoolClassSectionsSchema)
    .values({
      classId: data.classId,
      sectionId: data.sectionId,
      capacity: data.capacity,
      classTeacherId: data.classTeacherId,
      roomNumber: data.roomNumber,
      isActive: data.isActive,
    })
    .returning();

  return {
    classSection: newSection,
    message: "Class-Section created successfully",
  };
}

export async function getClassSections(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionsSchema.id,
      classId: schoolClassSectionsSchema.classId,
      className: schoolClassesSchema.name,
      sectionId: schoolClassSectionsSchema.sectionId,
      sectionName: schoolSectionsSchema.name,
      capacity: schoolClassSectionsSchema.capacity,
      classTeacherId: schoolClassSectionsSchema.classTeacherId,
      classTeacherName: schoolUsersSchema.name,
      roomNumber: schoolClassSectionsSchema.roomNumber,
      isActive: schoolClassSectionsSchema.isActive,
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
    .leftJoin(
      schoolUsersSchema,
      eq(schoolClassSectionsSchema.classTeacherId, schoolUsersSchema.id)
    )
    .orderBy(schoolClassesSchema.sort_order, schoolSectionsSchema.name);
}

export async function getAvailableClassSectionsForEnrollment(
  env: SchoolEnv["Bindings"],
  schoolCode: string
) {
  const db = await getSchoolDB(env, schoolCode);

  return await db
    .select({
      id: schoolClassSectionsSchema.id,
      displayName:
        sql`${schoolClassesSchema.name} || ' - ' || ${schoolSectionsSchema.name}`.as(
          "displayName"
        ),
      capacity: schoolClassSectionsSchema.capacity,
      // Current student count (Drizzle way – subquery)
      currentStudents: db.$count(
        schoolStudentEnrollmentsSchema,
        eq(
          schoolStudentEnrollmentsSchema.classSectionId,
          schoolClassSectionsSchema.id
        )
      ),
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
    .where(eq(schoolClassSectionsSchema.isActive, true));
}
