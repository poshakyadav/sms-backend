import { getSchoolDB } from "../../../db/school-client";
import { SchoolEnv } from "../../../types/common-types";
import { and, asc, eq } from "drizzle-orm"; // Fixed: Import and, eq
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { studentsSchema } from "../../../db/schemas/school/students";
import { SchoolRole } from "../../../types/school-role";

// ==================== Get Students ====================
export async function getStudents(env: SchoolEnv['Bindings'], schoolCode: string) {
  const db = await getSchoolDB(env, schoolCode);

  // Join school_users and students, filter by role='STUDENT' and isActive=true
  const students = await db
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      // Add more fields if needed, e.g., email: schoolUsersSchema.email, rollNumber: studentsSchema.rollNumber
    })
    .from(schoolUsersSchema)
    .innerJoin(studentsSchema, eq(schoolUsersSchema.id, studentsSchema.userId)) // Fixed: Use eq as function
    .where(and(
      eq(schoolUsersSchema.role, SchoolRole.STUDENT), // Fixed: Use eq/and as functions
      eq(schoolUsersSchema.isActive, true)
    ))
    .orderBy(asc(schoolUsersSchema.name)); // Alphabetical by name

  return students; // Array of {id, name}
}