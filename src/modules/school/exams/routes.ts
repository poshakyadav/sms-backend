import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import { getAdmitTemplate, getReportTemplate } from "./card-templates";
import {
  createExam,
  createOrUpdateTemplate,
  deleteExam,
  enterMarks,
  generateReportCard,
  getActiveTemplate,
  getAdmitCard,
  getExamById,
  getExams,
  getMarksByStudent,
  getStudentExams,
  getStudentOwnAdmitCard,
  getStudentOwnMarks,
  getStudentOwnReportCard,
  getTemplateConfig,
  publishExamCard,
  saveTemplateSelection,
  updateExam,
  updateExamStatus,
} from "./services";
import { registerMarksExcelRoutes } from "./marks-excel.routes";

const examsRouter = new Hono<SchoolEnv>();

examsRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== Exam Event CRUD ====================
const examSchema = z.object({
  academicYearId: z.number(),
  classSectionId: z.number(),
  name: z.string().min(3),

  // ── FREE-TEXT TYPE (replaces the strict enum) ─────────────────────────────
  // Staff can enter any exam type string (e.g. "Unit Test", "Pre-Board", "PTM").
  // The frontend shows quick-link chips for common values but does not restrict.
  type: z.string().min(1, "Exam type is required").max(60),

  description: z.string().optional(),
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

        // ── OPTIONAL CUSTOM PAPER LABEL ───────────────────────────────────
        // e.g. "English Paper One" — overrides the subject's canonical name
        // in timetable displays. If absent/empty the canonical name is used.
        subjectLabel: z.string().max(120).optional().nullable(),
      })
    )
    .min(1),
});

// POST /school/exams/
examsRouter.post(
  "/",
  requirePermission("exams.create"),
  zValidator("json", examSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createExam(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

// GET /school/exams/
examsRouter.get(
  "/",
  requirePermission("exams.create"), // Anyone who can create/edit exams can list them
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

// POST /school/exams/marks
examsRouter.post(
  "/marks",
  requirePermission("exams.marks.enter"),
  zValidator("json", marksSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const result = await enterMarks(c.env, schoolCode, data, user.id);
      return c.json(result, 200); // 200 not 201 since it may be an update
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Get Marks by Student ====================
// Staff: get marks by student (for marks entry page)
// GET /school/exams/marks/student
examsRouter.get(
  "/marks/student",
  requirePermission("exams.marks.enter"),
  zValidator(
    "query",
    z.object({
      studentId: z.coerce.number(),
      examId: z.coerce.number().optional(),
    })
  ),
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

// Register the marks Excel upload/download routes
registerMarksExcelRoutes(examsRouter);

// ─────────────────────────────────────────────────────────────────────────────
// STAFF: Admit Card & Report Card  (no publication gate — staff always sees)
// ─────────────────────────────────────────────────────────────────────────────

const staffCardQuerySchema = z.object({
  examId: z.coerce.number().int().positive({
    message: "examId must be a positive integer",
  }),
  studentId: z.coerce.number().int().positive({
    message: "studentId must be a positive integer",
  }),
});

// GET /school/exams/admit-card
examsRouter.get(
  "/admit-card",
  requirePermission("exams.admit-card"),
  zValidator("query", staffCardQuerySchema),
  async (c) => {
    try {
      const { examId, studentId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const admitCard = await getAdmitCard(
        c.env,
        schoolCode,
        examId,
        studentId
      );
      return c.json({ admitCard });
    } catch (error: any) {
      console.error("admit-card error:", error.message);
      return c.json({ error: error.message }, 500);
    }
  }
);

// GET /school/exams/report-card
examsRouter.get(
  "/report-card",
  requirePermission("exams.report-card"),
  zValidator("query", staffCardQuerySchema),
  async (c) => {
    try {
      const { examId, studentId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const reportCard = await generateReportCard(
        c.env,
        schoolCode,
        examId,
        studentId
      );
      return c.json({ reportCard });
    } catch (error: any) {
      console.error("report-card error:", error.message);
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT PORTAL
// ─────────────────────────────────────────────────────────────────────────────

// ==================== STUDENT: View own exams & marks ====================
// GET /school/exams/student/my
examsRouter.get(
  "/student/my",
  requirePermission("exams.student.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const user = c.get("user")!;
      const result = await getStudentExams(c.env, schoolCode, user.id);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// GET /school/exams/student/my/marks
examsRouter.get(
  "/student/my/marks",
  requirePermission("exams.student.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const user = c.get("user")!;
      const examId = c.req.query("examId")
        ? Number(c.req.query("examId"))
        : undefined;
      const result = await getStudentOwnMarks(
        c.env,
        schoolCode,
        user.id,
        examId
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── STUDENT: Admit Card ────────────────────────────────────────────────────
// Returns 403 with { notPublished: true } when admitCardPublished = false
// GET /school/exams/student/my/admit-card
examsRouter.get(
  "/student/my/admit-card",
  requirePermission("exams.student.admit-card"),
  zValidator("query", z.object({ examId: z.coerce.number() })),
  async (c) => {
    try {
      const { examId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const user = c.get("user")!;
      const admitCard = await getStudentOwnAdmitCard(
        c.env,
        schoolCode,
        examId,
        user.id
      );
      return c.json({ admitCard });
    } catch (error: any) {
      // Surface the publication-gate error with a structured body
      if (error.message === "ADMIT_CARD_NOT_PUBLISHED") {
        return c.json(
          {
            error:
              "Admit card has not been published yet. Please check back later.",
            notPublished: true,
          },
          403
        );
      }
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── STUDENT: Report Card ───────────────────────────────────────────────────
// GET /school/exams/student/my/report-card
examsRouter.get(
  "/student/my/report-card",
  requirePermission("exams.student.report-card"),
  zValidator("query", z.object({ examId: z.coerce.number() })),
  async (c) => {
    try {
      const { examId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const user = c.get("user")!;
      const reportCard = await getStudentOwnReportCard(
        c.env,
        schoolCode,
        examId,
        user.id
      );
      return c.json({ reportCard });
    } catch (error: any) {
      if (error.message === "REPORT_CARD_NOT_PUBLISHED") {
        return c.json(
          {
            error:
              "Report card has not been published yet. Please check back later.",
            notPublished: true,
          },
          403
        );
      }
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PARENT PORTAL
// ─────────────────────────────────────────────────────────────────────────────

// ==================== PARENT: View child's exams & marks ====================
// GET /school/exams/parent/child
examsRouter.get(
  "/parent/child",
  requirePermission("exams.parent.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const activeChildId = c.req.header("X-Active-Child-Id");
      if (!activeChildId)
        return c.json({ error: "No active child selected" }, 400);
      const result = await getStudentExams(
        c.env,
        schoolCode,
        Number(activeChildId)
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// GET /school/exams/parent/child/marks
examsRouter.get(
  "/parent/child/marks",
  requirePermission("exams.parent.view"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const activeChildId = c.req.header("X-Active-Child-Id");
      if (!activeChildId)
        return c.json({ error: "No active child selected" }, 400);
      const examId = c.req.query("examId")
        ? Number(c.req.query("examId"))
        : undefined;
      const result = await getStudentOwnMarks(
        c.env,
        schoolCode,
        Number(activeChildId),
        examId
      );
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── PARENT: Admit Card ─────────────────────────────────────────────────────
// GET /school/exams/parent/child/admit-card
examsRouter.get(
  "/parent/child/admit-card",
  requirePermission("exams.parent.admit-card"),
  zValidator("query", z.object({ examId: z.coerce.number() })),
  async (c) => {
    try {
      const { examId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const activeChildId = c.req.header("X-Active-Child-Id");
      if (!activeChildId)
        return c.json({ error: "No active child selected" }, 400);
      const admitCard = await getStudentOwnAdmitCard(
        c.env,
        schoolCode,
        examId,
        Number(activeChildId)
      );
      return c.json({ admitCard });
    } catch (error: any) {
      if (error.message === "ADMIT_CARD_NOT_PUBLISHED") {
        return c.json(
          {
            error:
              "Admit card has not been published yet. Please check back later.",
            notPublished: true,
          },
          403
        );
      }
      return c.json({ error: error.message }, 500);
    }
  }
);

// ── PARENT: Report Card ────────────────────────────────────────────────────
// GET /school/exams/parent/child/report-card
examsRouter.get(
  "/parent/child/report-card",
  requirePermission("exams.parent.report-card"),
  zValidator("query", z.object({ examId: z.coerce.number() })),
  async (c) => {
    try {
      const { examId } = c.req.valid("query");
      const schoolCode = c.get("schoolCode")!;
      const activeChildId = c.req.header("X-Active-Child-Id");
      if (!activeChildId)
        return c.json({ error: "No active child selected" }, 400);
      const reportCard = await getStudentOwnReportCard(
        c.env,
        schoolCode,
        examId,
        Number(activeChildId)
      );
      return c.json({ reportCard });
    } catch (error: any) {
      if (error.message === "REPORT_CARD_NOT_PUBLISHED") {
        return c.json(
          {
            error:
              "Report card has not been published yet. Please check back later.",
            notPublished: true,
          },
          403
        );
      }
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE MANAGEMENT (new key-based system)
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/exams/templates/config/:type — returns available templates + currently active key
examsRouter.get(
  "/templates/config/:type",
  requirePermission("exams.templates.manage"),
  async (c) => {
    try {
      const type = c.req.param("type") as "ADMIT_CARD" | "REPORT_CARD";
      if (!["ADMIT_CARD", "REPORT_CARD"].includes(type)) {
        return c.json({ error: "Invalid template type" }, 400);
      }
      const schoolCode = c.get("schoolCode")!;
      const config = await getTemplateConfig(c.env, schoolCode, type);
      return c.json(config);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// POST /school/exams/templates/select — save chosen template key
examsRouter.post(
  "/templates/select",
  requirePermission("exams.templates.manage"),
  zValidator(
    "json",
    z.object({
      type: z.enum(["ADMIT_CARD", "REPORT_CARD"]),
      templateKey: z.string().min(1),
      name: z.string().min(1),
    })
  ),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await saveTemplateSelection(c.env, schoolCode, data);
      return c.json(result, 200);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ==================== Template Management ====================
// POST /school/exams/templates
const templateSchema = z.object({
  type: z.enum(["ADMIT_CARD", "REPORT_CARD"]),
  name: z.string().min(3),
  htmlContent: z.string().min(100),
  templateKey: z.string().optional(),
});

examsRouter.post(
  "/templates",
  requirePermission("exams.templates.manage"),
  zValidator("json", templateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createOrUpdateTemplate(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

// GET /school/exams/templates/:type
examsRouter.get(
  "/templates/:type",
  requirePermission([
    "exams.templates.manage",
    "exams.create",
    "students.view.own",
  ]),
  async (c) => {
    try {
      const type = c.req.param("type") as "ADMIT_CARD" | "REPORT_CARD";
      const key = c.req.query("key");
      const schoolCode = c.get("schoolCode")!;

      if (key) {
        // Return specific template by key (for preview)
        const tmpl =
          type === "ADMIT_CARD"
            ? getAdmitTemplate(key)
            : getReportTemplate(key);
        return c.json({ template: tmpl });
      }

      const template = await getActiveTemplate(c.env, schoolCode, type);
      return c.json({ template });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC ROUTES — /:id and /:id/sub-paths MUST come LAST
// ─────────────────────────────────────────────────────────────────────────────

// GET single exam by ID
// GET /school/exams/:id
examsRouter.get("/:id", requirePermission("exams.create"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id <= 0) {
      return c.json({ error: "Invalid exam ID" }, 400);
    }
    const schoolCode = c.get("schoolCode")!;
    const exam = await getExamById(c.env, schoolCode, id);
    return c.json({ exam });
  } catch (error: any) {
    return c.json({ error: error.message }, 404);
  }
});

// PUT /school/exams/:id
examsRouter.put(
  "/:id",
  requirePermission("exams.edit"),
  zValidator("json", examSchema.partial()),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id) || id <= 0) {
        return c.json({ error: "Invalid exam ID" }, 400);
      }
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateExam(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// DELETE /school/exams/:id
examsRouter.delete("/:id", requirePermission("exams.edit"), async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id <= 0) {
      return c.json({ error: "Invalid exam ID" }, 400);
    }
    const schoolCode = c.get("schoolCode")!;
    const result = await deleteExam(c.env, schoolCode, id);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EXAM STATUS MANAGEMENT  (Feature 2)
// PATCH /school/exams/:id/status
// Permission: exams.status.manage
// Body: { status: "SCHEDULED" | "ACTIVE" | "COMPLETED" }
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /school/exams/:id/status
examsRouter.patch(
  "/:id/status",
  requirePermission("exams.edit"),
  zValidator(
    "json",
    z.object({
      status: z.enum(["SCHEDULED", "ACTIVE", "COMPLETED"]),
    })
  ),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id) || id <= 0) {
        return c.json({ error: "Invalid exam ID" }, 400);
      }
      const { status } = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await updateExamStatus(c.env, schoolCode, id, status);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CARD PUBLICATION MANAGEMENT  (Feature 1)
// PATCH /school/exams/:id/publish
// Permission: exams.admit-card.publish  OR  exams.report-card.publish
// Body: { cardType: "ADMIT_CARD" | "REPORT_CARD", published: boolean }
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /school/exams/:id/publish
examsRouter.patch(
  "/:id/publish",
  requirePermission(["exams.admit-card.publish", "exams.report-card.publish"]),
  zValidator(
    "json",
    z.object({
      cardType: z.enum(["ADMIT_CARD", "REPORT_CARD"]),
      published: z.boolean(),
    })
  ),
  async (c) => {
    try {
      const id = parseInt(c.req.param("id"));
      if (isNaN(id) || id <= 0) {
        return c.json({ error: "Invalid exam ID" }, 400);
      }
      const data = c.req.valid("json");
      const schoolCode = c.get("schoolCode")!;
      const result = await publishExamCard(c.env, schoolCode, id, data);
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  }
);

export default examsRouter;
