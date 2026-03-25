import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  jwtMiddleware,
  permissionMiddleware,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { schoolsSchema, tursoDatabasesSchema } from "../../../db";
import { eq, and, sql } from "drizzle-orm"; // Removed isNull as it's not used
import { nanoid } from "nanoid";
import { sendTransactionalEmail } from "../../../utils/sendEmail"; // Import Brevo util
import { BrevoSendEmailRequest } from "../../../types/brevo"; // Import type

const schoolsRouter = new Hono<Env>();

// ==================== PUBLIC ROUTE (NO AUTH REQUIRED) ====================
// Public route for school list (added before middleware for no auth)
schoolsRouter.get("/list", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const schools = await db
      .select({
        name: schoolsSchema.name,
        uniqueCode: schoolsSchema.uniqueCode,
      })
      .from(schoolsSchema)
      .all();

    const formattedSchools = schools.map(
      (school) => `${school.name} - ${school.uniqueCode}`
    );

    return c.json({ schools: formattedSchools });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Public route to get school details by code (for pre-fill in signup)
schoolsRouter.get("/:code/details", async (c) => {
  try {
    const code = c.req.param("code");
    const db = getCommonDB(c.env);
    const school = await db
      .select()
      .from(schoolsSchema)
      .where(eq(schoolsSchema.uniqueCode, code))
      .get();

    if (!school) return c.json({ error: "School not found" }, 404);

    return c.json(school);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ==================== PROTECTED ROUTES ====================
schoolsRouter.use(
  "*",
  jwtMiddleware,
  permissionMiddleware(["canManageSchools"])
);

const createSchema = z.object({
  name: z.string(), // school name
  email: z.string().email(), // Require school owner's email
  addressLineOne: z.string(), // Require school address
  addressLineTwo: z.string().optional(), // Optional second line for school address
  phone: z.string(), // Require school phone
  alternatePhone: z.string().optional(), // Optional alternate phone
});
schoolsRouter.post("/", zValidator("json", createSchema), async (c) => {
  try {
    const {
      name,
      email,
      addressLineOne,
      addressLineTwo,
      phone,
      alternatePhone,
    } = c.req.valid("json"); // New: Extract email
    const db = getCommonDB(c.env);

    // Generate unique code, e.g., 'GH' + nanoid(5).toUpperCase()
    const uniqueCode = `GH${nanoid(5).toUpperCase()}`;
    console.log("Generated unique code for school:", uniqueCode);

    const [newSchool] = await db
      .insert(schoolsSchema)
      .values({
        name,
        uniqueCode,
        email,
        addressLineOne,
        addressLineTwo,
        phone,
        alternatePhone,
      })
      .returning(); // New: Insert email
    return c.json(newSchool, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// Defining Frontend URL
const FRONTEND_URL = "http://localhost:4200"; // In production, use your actual frontend URL

// Helper function to send invite email (reused by both routes)
async function sendSchoolInviteEmail(c: any, school: any) {
  const inviteLink = `${FRONTEND_URL}/school/signup?code=${school.uniqueCode}`;

  const emailData: BrevoSendEmailRequest = {
    sender: {
      email: c.env.BREVO_SENDER_EMAIL,
      name: c.env.BREVO_SENDER_NAME,
    },
    to: [{ email: school.email, name: school.name }],
    subject: "Invitation to Join School Management System (SMS)",
    htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 20px auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; padding: 10px 0; }
          .header h1 { color: #333; }
          .content { padding: 20px 0; }
          .button { display: inline-block; padding: 10px 20px; background-color: #007bff; color: white !important; text-decoration: none; border-radius: 5px; }
          .footer { text-align: center; padding: 10px 0; color: #777; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to SMS!</h1>
          </div>
          <div class="content">
            <p>Dear ${school.name},</p>
            <p>You have been invited to set up your school account in our School Management System.</p>
            <p style="text-align: center;">
              <a href="${inviteLink}" class="button">Sign Up Now</a>
            </p>
            <p>If the button doesn't work, copy and paste this link into your browser: <a href="${inviteLink}">${inviteLink}</a></p>
          </div>
          <div class="footer">
            <p>Best regards,<br>SMS Team</p>
            <p>If you didn't request this, please ignore this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  const result = await sendTransactionalEmail(c.env, emailData);
  if ("error" in result) {
    console.error("Brevo email failed:", result.error);
    return { success: false, error: result.error };
  }
  return { success: true, messageId: result.messageId };
}

// Send Invite - And also checks if already assigned
schoolsRouter.post(
  "/:id/send-invite",
  permissionMiddleware(["canSendSchoolInvites"]),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);

      const school = await db
        .select()
        .from(schoolsSchema)
        .where(eq(schoolsSchema.id, schoolId))
        .get();

      if (!school) return c.json({ error: "School not found" }, 404);

      // Check if already assigned
      if (school.tursoDbId) {
        console.log(
          `School ${schoolId} already has DB ${school.tursoDbId}. Skipping allocation, sending email only.`
        );
        const emailResult = await sendSchoolInviteEmail(c, school);
        return c.json({
          message: "School already has database. Invite resent.",
          inviteLink: `${FRONTEND_URL}/school/signup?code=${school.uniqueCode}`,
          emailSent: emailResult.success,
          ...(emailResult.success ? {} : { emailError: emailResult.error }),
        });
      }

      // Assign only if not assigned
      const available = await db
        .select()
        .from(tursoDatabasesSchema)
        .where(eq(tursoDatabasesSchema.isAssigned, false))
        .limit(1)
        .get();

      if (!available) {
        return c.json(
          { error: "No available databases. Please configure more." },
          400
        );
      }

      // Assign DB
      await db
        .update(schoolsSchema)
        .set({ tursoDbId: available.id })
        .where(eq(schoolsSchema.id, schoolId));

      await db
        .update(tursoDatabasesSchema)
        .set({ isAssigned: true })
        .where(eq(tursoDatabasesSchema.id, available.id));

      console.log(`Assigned DB ${available.id} to school ${schoolId}`);

      // Refresh school object after update
      const updatedSchool = await db
        .select()
        .from(schoolsSchema)
        .where(eq(schoolsSchema.id, schoolId))
        .get();

      if (!updatedSchool) {
        // This shouldn't happen, but handle for safety
        console.error("Updated school not found after assignment");
        return c.json({ error: "Internal error after assignment" }, 500);
      }

      const emailResult = await sendSchoolInviteEmail(c, updatedSchool);

      return c.json({
        message: "Database assigned and invite sent.",
        inviteLink: `${FRONTEND_URL}/school/signup?code=${updatedSchool.uniqueCode}`,
        emailSent: emailResult.success,
        ...(emailResult.success ? {} : { emailError: emailResult.error }),
      });
    } catch (error: any) {
      console.error("Send invite error:", error);
      return c.json({ error: error.message || "Failed to send invite" }, 500);
    }
  }
);

// Unassign DB Route (to fix stuck assignments)
// pass the school ID (from the schools table)
schoolsRouter.post(
  "/:id/unassign-db",
  permissionMiddleware(["canManageSchools"]), // Or stricter if needed
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);

      const school = await db
        .select()
        .from(schoolsSchema)
        .where(eq(schoolsSchema.id, schoolId))
        .get();

      if (!school) return c.json({ error: "School not found" }, 404);
      if (!school.tursoDbId)
        return c.json({ message: "No database assigned to unassign" }, 200);

      // Unassign from school
      await db
        .update(schoolsSchema)
        .set({ tursoDbId: null })
        .where(eq(schoolsSchema.id, schoolId));

      // Mark DB as unassigned
      await db
        .update(tursoDatabasesSchema)
        .set({ isAssigned: false })
        .where(eq(tursoDatabasesSchema.id, school.tursoDbId));

      console.log(`Unassigned DB ${school.tursoDbId} from school ${schoolId}`);

      return c.json({ message: "Database unassigned successfully" });
    } catch (error: any) {
      console.error("Unassign DB error:", error);
      return c.json(
        { error: error.message || "Failed to unassign database" },
        500
      );
    }
  }
);

// Bulk Unassign Unused DBs Route
schoolsRouter.post(
  "/unassign-unused-dbs",
  permissionMiddleware(["canManageSchools"]),
  async (c) => {
    try {
      const db = getCommonDB(c.env);

      // Step 1: Get all assigned DBs
      const assignedDbs = await db
        .select({ id: tursoDatabasesSchema.id })
        .from(tursoDatabasesSchema)
        .where(eq(tursoDatabasesSchema.isAssigned, true))
        .all();

      if (assignedDbs.length === 0) {
        return c.json({ message: "No assigned databases found", unassignedCount: 0 });
      }

      let unassignedCount = 0;

      // Step 2: For each assigned DB, check if used by any school
      for (const dbRecord of assignedDbs) {
        const usingSchools = await db
          .select({ count: sql`COUNT(*)` })
          .from(schoolsSchema)
          .where(eq(schoolsSchema.tursoDbId, dbRecord.id))
          .get();

        // FIXED: Handle possible undefined (though COUNT always returns a row)
        const schoolCount = usingSchools?.count as number ?? 0;

        if (schoolCount === 0) {
          // Orphan DB → unassign
          await db
            .update(tursoDatabasesSchema)
            .set({ isAssigned: false })
            .where(eq(tursoDatabasesSchema.id, dbRecord.id));

          console.log(`Unassigned orphan DB ${dbRecord.id}`);
          unassignedCount++;
        }
      }

      return c.json({
        message: `Cleanup complete. Unassigned ${unassignedCount} orphan databases.`,
        unassignedCount,
      });
    } catch (error: any) {
      console.error("Unassign unused DBs error:", error);
      return c.json({ error: error.message || "Failed to unassign unused databases" }, 500);
    }
  }
);

// Resend Invite Route
schoolsRouter.post(
  "/:id/resend-invite",
  permissionMiddleware(["canSendSchoolInvites"]),
  async (c) => {
    try {
      const schoolId = parseInt(c.req.param("id"));
      const db = getCommonDB(c.env);

      const school = await db
        .select()
        .from(schoolsSchema)
        .where(eq(schoolsSchema.id, schoolId))
        .get();

      if (!school) return c.json({ error: "School not found" }, 404);
      if (!school.tursoDbId) {
        return c.json(
          { error: "School has no database assigned yet. Send invite first." },
          400
        );
      }

      const emailResult = await sendSchoolInviteEmail(c, school);

      return c.json({
        message: "Resend invite processed",
        emailSent: emailResult.success,
        ...(emailResult.success ? {} : { emailError: emailResult.error }),
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  }
);

// List all schools
schoolsRouter.get("/", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const schools = await db.select().from(schoolsSchema).all();
    return c.json(schools);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get school by ID
schoolsRouter.get("/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const db = getCommonDB(c.env);
    const school = await db
      .select()
      .from(schoolsSchema)
      .where(eq(schoolsSchema.id, id))
      .get();
    if (!school) return c.json({ error: "School not found" }, 404);
    return c.json(school);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default schoolsRouter;
