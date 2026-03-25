import { relations } from "drizzle-orm";
import { schoolClassSectionsSchema } from "./school-class-sections";
import { schoolClassesSchema } from "./school-classes";
import { schoolSectionsSchema } from "./school-sections";
import { schoolUsersSchema } from "./school-users";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import { schoolAssignmentsSchema } from "./school-assignments";
import { schoolFeeStructuresSchema } from "./school-fee-structures";

export const schoolClassSectionsRelations = relations(
  schoolClassSectionsSchema,
  ({ one, many }) => ({
    class: one(schoolClassesSchema, {
      fields: [schoolClassSectionsSchema.classId],
      references: [schoolClassesSchema.id],
    }),
    section: one(schoolSectionsSchema, {
      fields: [schoolClassSectionsSchema.sectionId],
      references: [schoolSectionsSchema.id],
    }),
    classTeacher: one(schoolUsersSchema, {
      fields: [schoolClassSectionsSchema.classTeacherId],
      references: [schoolUsersSchema.id],
    }),
    enrollments: many(schoolStudentEnrollmentsSchema),
    assignments: many(schoolAssignmentsSchema),
    feeStructures: many(schoolFeeStructuresSchema),
  })
);
