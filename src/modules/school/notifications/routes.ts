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
  createNotification,
  getNotifications,
  markNotificationRead,
  getUnreadCount,
  getNotificationReport,
} from "./services";

const notificationsRouter = new Hono<SchoolEnv>();

notificationsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

const notificationSchema = z
  .object({
    title: z.string().min(3, "Title must be at least 3 characters"),
    message: z.string().min(10, "Message must be at least 10 characters"),
    targetType: z.enum([
      "SCHOOL",
      "CLASS",
      "STUDENT",
      "ALL_STAFF",
      "INTERNAL_STAFF",
      "OPERATION_STAFF",
      "STUDENT_PARENT",
      "EXTERNAL_USER",
    ]),
    classSectionId: z.number().optional(),
    studentId: z.number().optional(),
    dueDate: z.string().optional(),
    link: z.string().optional(),
  })
  .refine(
    (data) => {
      if (["CLASS", "EXTERNAL_USER"].includes(data.targetType))
        return data.classSectionId !== undefined;
      return true;
    },
    {
      message: "classSectionId is required for CLASS and EXTERNAL_USER",
      path: ["classSectionId"],
    }
  )
  .refine(
    (data) => {
      if (data.targetType === "STUDENT") return data.studentId !== undefined;
      return true;
    },
    { message: "studentId is required for STUDENT", path: ["studentId"] }
  );

// ==================== Create ====================
notificationsRouter.post(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
  zValidator("json", notificationSchema),
  async (c) => {
    const data = c.req.valid("json");
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;
    const result = await createNotification(c.env, schoolCode, data, user.id);
    return c.json(result, 201);
  }
);

// ==================== Get My Notifications ====================
notificationsRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const schoolCode = c.get("schoolCode")!;
  const notifications = await getNotifications(
    c.env,
    schoolCode,
    user.id,
    user.role as SchoolRole
  );
  return c.json({ notifications });
});

// ==================== Mark Read ====================
const markReadSchema = z.object({ notificationId: z.number() });
notificationsRouter.post(
  "/mark-read",
  zValidator("json", markReadSchema),
  async (c) => {
    const { notificationId } = c.req.valid("json");
    const user = c.get("user")!;
    const schoolCode = c.get("schoolCode")!;
    const result = await markNotificationRead(
      c.env,
      schoolCode,
      notificationId,
      user.id
    );
    return c.json(result);
  }
);

// ==================== Unread Count ====================
notificationsRouter.get("/unread-count", async (c) => {
  const user = c.get("user")!;
  const schoolCode = c.get("schoolCode")!;
  const count = await getUnreadCount(
    c.env,
    schoolCode,
    user.id,
    user.role as SchoolRole
  );
  return c.json({ count });
});

// ==================== Report (Admin only) ====================
notificationsRouter.get(
  "/report/:id",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const schoolCode = c.get("schoolCode")!;
    const report = await getNotificationReport(c.env, schoolCode, id);
    return c.json({ report });
  }
);

export default notificationsRouter;
