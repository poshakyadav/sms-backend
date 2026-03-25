import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
  schoolPermissionMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import {
  createExam,
  getExams,
  updateExam,
  deleteExam,
  enterMarks,
  getMarksByStudent,
  generateReportCard,
  getAdmitCard,
  getActiveTemplate,
  createOrUpdateTemplate,
} from "./services";

const examsRouter = new Hono<SchoolEnv>();

examsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Exam Event CRUD ====================
const examSchema = z.object({
  academicYearId: z.number(),
  classSectionId: z.number(), // ← CHANGED: now per class-section
  name: z.string().min(3),
  type: z.enum(["MID_TERM", "FINAL", "QUIZ"]),
  description: z.string().optional(),
  // Subjects will be sent as array (timetable)
  subjects: z
    .array(
      z.object({
        classSubjectId: z.number(),
        date: z.string().date(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        roomNumber: z.string().optional(),
        maxMarks: z.number().positive(),
        passingMarks: z.number().positive().optional(),
      })
    )
    .min(1),
});

examsRouter.post(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.TEACHER,
  ]),
  zValidator("json", examSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createExam(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

examsRouter.get(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
    SchoolRole.TEACHER,
  ]),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;

      const exams = await getExams(c.env, schoolCode);

      return c.json({ exams });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

examsRouter.put(
  "/:id",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.TEACHER,
  ]),
  zValidator("json", examSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;

      const result = await updateExam(c.env, schoolCode, id, data);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

examsRouter.delete(
  "/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      const schoolCode = c.get("schoolCode")!;

      const result = await deleteExam(c.env, schoolCode, id);

      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Marks Bulk Entry ====================
const marksSchema = z.object({
  examId: z.number(),
  classSubjectId: z.number(), // ← NEW: teacher picks subject
  marks: z.array(
    z.object({
      enrollmentId: z.number(),
      marksObtained: z.number(),
      grade: z.string().optional(),
      remarks: z.string().optional(),
    })
  ),
});

examsRouter.post(
  "/marks",
  schoolPermissionMiddleware([SchoolRole.TEACHER, SchoolRole.PRINCIPAL]),
  zValidator("json", marksSchema),
  async (c) => {
    const data = c.req.valid("json");
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;
    const result = await enterMarks(c.env, schoolCode, data, user.id);
    return c.json(result, 201);
  }
);

// ===

// ==================== Get Marks by Student ====================
const studentMarksSchema = z.object({
  studentId: z.number(),
  examId: z.number().optional(),
});

examsRouter.get(
  "/marks/student",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.TEACHER,
    SchoolRole.STUDENT,
    SchoolRole.STUDENT_PARENT,
  ]),
  zValidator("query", studentMarksSchema),
  async (c) => {
    try {
      const { studentId, examId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;

      const marks = await getMarksByStudent(
        c.env,
        schoolCode,
        studentId,
        examId
      );

      return c.json({ marks });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ==================== Template Management (NEW – only for admins) ====================
const templateSchema = z.object({
  type: z.enum(["ADMIT_CARD", "REPORT_CARD"]),
  name: z.string().min(3),
  htmlContent: z.string().min(100), // full HTML + Tailwind
});

examsRouter.post(
  "/templates",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", templateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createOrUpdateTemplate(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

examsRouter.get(
  "/templates/:type",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.TEACHER,
    SchoolRole.STUDENT,
    SchoolRole.STUDENT_PARENT,
  ]),
  async (c) => {
    const type = c.req.param("type") as "ADMIT_CARD" | "REPORT_CARD";
    const schoolCode = c.get("schoolCode")!;
    const template = await getActiveTemplate(c.env, schoolCode, type);
    return c.json({ template });
  }
);

// ==================== Admit Card & Report Card (now with template) ====================
// ==================== Admit Card (Printable) ====================
examsRouter.get(
  "/admit-card",
  schoolPermissionMiddleware([
    SchoolRole.STUDENT,
    SchoolRole.STUDENT_PARENT,
    SchoolRole.TEACHER,
    SchoolRole.PRINCIPAL,
  ]),
  zValidator("query", z.object({ examId: z.number(), studentId: z.number() })),
  async (c) => {
    const { examId, studentId } = c.req.valid("query");
    const schoolCode = c.get("schoolCode")!;
    const admitCard = await getAdmitCard(c.env, schoolCode, examId, studentId);
    return c.json({ admitCard });
  }
);

// Report Card (now per exam, not year)
examsRouter.get(
  "/report-card",
  schoolPermissionMiddleware([
    SchoolRole.STUDENT,
    SchoolRole.STUDENT_PARENT,
    SchoolRole.TEACHER,
  ]),
  zValidator("query", z.object({ examId: z.number(), studentId: z.number() })),
  async (c) => {
    const { examId, studentId } = c.req.valid("query");
    const schoolCode = c.get("schoolCode")!;
    const reportCard = await generateReportCard(
      c.env,
      schoolCode,
      examId,
      studentId
    );
    return c.json({ reportCard });
  }
);

export default examsRouter;
