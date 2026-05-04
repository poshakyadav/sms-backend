import { Hono } from "hono";
import { cors } from "hono/cors";
import classesRouter from "./modules/school/academics/classes/routes";
import academicsRouter from "./modules/school/academics/routes";
import sectionsRouter from "./modules/school/academics/sections/routes";
import assignmentsRouter from "./modules/school/assignments/routes";
import attendanceRouter from "./modules/school/attendance/routes";
import schoolAuthRouter from "./modules/school/auth/routes";
import schoolDashboardRouter from "./modules/school/dashboard/routes";
import feesRouter from "./modules/school/fees/routes";
import rolesRouter from "./modules/school/roles/routes";
import studentsRouter from "./modules/school/students/routes";
import subjectsRouter from "./modules/school/subjects/routes";
import schoolUsersRouter from "./modules/school/users/routes";
import authRouter from "./modules/super/auth/routes";
import superDashboardRouter from "./modules/super/dashboard/routes";
import schoolsRouter from "./modules/super/schools/routes";
import tursoDbsRouter from "./modules/super/turso-dbs/routes";
import usersRouter from "./modules/super/users/routes";
import { Env } from "./types/common-types";
import classSectionsRouter from "./modules/school/academics/class-sections/routes";
import classSectionMappingsRouter from "./modules/school/academics/class-section-mappings/routes";
import superRolesRouter from "./modules/super/roles/routes";
import permissionsRouter from "./modules/super/permissions/routes";
import parentRouter from "./modules/school/parent/routes";
import paymentConfigRouter from "./modules/super/payment-config/routes";
import invitationsRouter from "./modules/super/invitations/routes";
import approvalsRouter from "./modules/super/approvals/routes";
import setupRouter from "./modules/super/auth/setup-routes/routes";
import notificationsRouter from "./modules/school/notifications/routes";
import schoolSettingsRouter from "./modules/school/settings/routes";
import profileRouter from "./modules/school/profile/routes";
import examsRouter from "./modules/school/exams/routes";
import publicSchoolRequestsRouter from "./modules/public/school-registration-requests/routes";
import schoolContactRouter from "./modules/school/contact/routes";
import superSchoolRequestsRouter from "./modules/super/school-requests/routes";
import superContactMessagesRouter from "./modules/super/contact-messages/routes";
import schoolPermissionsRouter from "./modules/school/permissions/routes";
import schoolInfoRouter from "./modules/school/info/routes";
import aboutUsRouter from "./modules/school/about-us/routes";
import schoolPermissionsSyncRouter from "./modules/super/school-permissions-sync/routes";

const app = new Hono<Env>();

// Add CORS middleware globally (production-grade)
app.use(
  "*",
  cors({
    origin: ["http://localhost:4200"], // Allow frontend dev origin; in prod: ['https://your-frontend.com'] or '*'
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], // Allow needed methods
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-School-Code",
      "X-Active-Child-Id",
    ], // Allow JWT/custom headers
    exposeHeaders: ["Content-Length"], // If needed
    maxAge: 600, // Preflight cache
    credentials: true, // If cookies/auth needed
  })
);

// Public (no auth)
app.route("/public/school-requests", publicSchoolRequestsRouter);

// Super routes
app.route("/auth", authRouter);
app.route("/auth/setup", setupRouter); // Public: one-time setup (goes 404 after first user is created)
app.route("/users", usersRouter);
app.route("/super/roles", superRolesRouter);
app.route("/turso-dbs", tursoDbsRouter);
app.route("/dashboard", superDashboardRouter);
app.route("/schools", schoolsRouter);
app.route("/permissions", permissionsRouter);
app.route("/payment-config", paymentConfigRouter);
app.route("/invitations", invitationsRouter);
app.route("/approvals", approvalsRouter);
// Super admin
app.route("/school-requests", superSchoolRequestsRouter);
app.route("/contact-messages", superContactMessagesRouter);
app.route("/school-permissions-sync", schoolPermissionsSyncRouter);

// School routes
app.route("/school/info", schoolInfoRouter);
app.route("/school/about-us", aboutUsRouter);
app.route("/school/auth", schoolAuthRouter);
app.route("/school/users", schoolUsersRouter);
app.route("/school/notifications", notificationsRouter);
app.route("/school/settings", schoolSettingsRouter);
app.route("/school/profile", profileRouter);
app.route("/school/students", studentsRouter);
app.route("/school/academics", academicsRouter);
app.route("/school/academics", classesRouter);
app.route("/school/academics", sectionsRouter);
app.route("/school/academics", classSectionsRouter);
app.route("/school/academics/mappings", classSectionMappingsRouter); // class-section-mappings
app.route("/school/attendance", attendanceRouter);
app.route("/school/assignments", assignmentsRouter);
app.route("/school/fees", feesRouter);
app.route("/school/subjects", subjectsRouter);
app.route("/school/exams", examsRouter);
app.route("/school/dashboard", schoolDashboardRouter);
app.route("/school/roles", rolesRouter);
app.route("/school/permissions", schoolPermissionsRouter);
app.route("/school/parent", parentRouter);

// School (authenticated)
app.route("/contact", schoolContactRouter);

app.get("/", (c) => c.text("Hello Hono!"));

export default app;
