import { Hono } from "hono";
import { schoolJwtMiddleware, schoolPermissionMiddleware, schoolTokenValidationMiddleware } from "../../../../middleware/school-auth";
import { SchoolRole } from "../../../../types/school-role";
import { SchoolEnv } from "../../../../types/common-types";
import z from "zod";
import { zValidator } from "@hono/zod-validator";
import { createClassSection, getAvailableClassSectionsForEnrollment, getClassSections } from "./services";


const classSectionsRouter = new Hono<SchoolEnv>();

classSectionsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

const classSectionSchema = z.object({
  classId: z.number().int().positive(),
  sectionId: z.number().int().positive(),
  capacity: z.number().int().min(1).max(100).default(40),
  classTeacherId: z.number().int().positive().optional().nullable(),
  roomNumber: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

classSectionsRouter.post(
  "/class-sections",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER]),
  zValidator("json", classSectionSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createClassSection(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

classSectionsRouter.get(
  "/class-sections",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL, SchoolRole.MANAGER, SchoolRole.TEACHER]),
  async (c) => {
    const schoolCode = c.get("schoolCode")!;
    const sections = await getClassSections(c.env, schoolCode);
    return c.json({ classSections: sections });
  }
);

// NEW: For enrollment dropdown (very useful)
classSectionsRouter.get(
  "/class-sections/available",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.ADMISSION_OFFICER, SchoolRole.PRINCIPAL]),
  async (c) => {
    const schoolCode = c.get("schoolCode")!;
    const sections = await getAvailableClassSectionsForEnrollment(c.env, schoolCode);
    return c.json({ available: sections });
  }
);

export default classSectionsRouter;