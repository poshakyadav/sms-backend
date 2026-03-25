import { Hono } from "hono";
import router from "./routes";
import { Env } from "./types/common-types";
import authRouter from "./modules/super/auth/routes";
import usersRouter from "./modules/super/users/routes";
import permissionsRouter from "./modules/super/permissions/routes";
import tursoDbsRouter from "./modules/super/turso-dbs/routes";
import schoolsRouter from "./modules/super/schools/routes";
import schoolAuthRouter from "./modules/school/auth/routes";
import schoolUsersRouter from "./modules/school/users/routes";
import academicsRouter from "./modules/school/academics/routes";
import classesRouter from "./modules/school/academics/classes/routes";
import sectionsRouter from "./modules/school/academics/sections/routes";
import attendanceRouter from "./modules/school/attendance/routes";
import feesRouter from "./modules/school/fees/routes";
import subjectsRouter from "./modules/school/subjects/routes";
import { cors } from "hono/cors";
import schoolDashboardRouter from "./modules/school/dashboard/routes";
import superDashboardRouter from "./modules/super/dashboard/routes";
import studentsRouter from "./modules/school/students/routes";
import assignmentsRouter from "./modules/school/assignments/routes";

const app = new Hono<Env>();

// New: Add CORS middleware globally (production-grade)
app.use(
  "*",
  cors({
    origin: ["http://localhost:4200"], // Allow frontend dev origin; in prod: ['https://your-frontend.com'] or '*'
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], // Allow needed methods
    allowHeaders: ["Content-Type", "Authorization"], // Allow JWT/custom headers
    exposeHeaders: ["Content-Length"], // If needed
    maxAge: 600, // Preflight cache
    credentials: true, // If cookies/auth needed
  })
);

app.route("/auth", authRouter);
app.route("/users", usersRouter);
app.route("/permissions", permissionsRouter);
app.route("/turso-dbs", tursoDbsRouter);
app.route('/dashboard', superDashboardRouter);
app.route("/schools", schoolsRouter);
app.route("/school/auth", schoolAuthRouter);
app.route("/school/users", schoolUsersRouter);
app.route("/school/students", studentsRouter);
app.route("/school/academics", academicsRouter);
app.route("/school/academics", classesRouter);
app.route("/school/academics", sectionsRouter);
app.route("/school/attendance", attendanceRouter);
app.route("/school/assignments", assignmentsRouter);
app.route("/school/fees", feesRouter);
app.route("/school/subjects", subjectsRouter);
app.route("/school/dashboard", schoolDashboardRouter);

app.get("/", (c) => c.text("Hello Hono!"));

export default app;
