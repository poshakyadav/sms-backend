import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { SchoolEnv } from "../../../types/common-types";
import { getSchoolDB } from "../../../db/school-client";
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { eq } from "drizzle-orm";
import { hashPassword, comparePassword } from "../../../utils/hashing";
import {
  generateSchoolAccessToken,
  generateSchoolRefreshToken,
  validateSchoolRefreshToken,
} from "../../../utils/school/tokens";
import { SchoolRole } from "../../../types/school-role";
import {
  schoolRefreshTokensSchema,
  schoolsSchema,
} from "../../../db/schemas/school";
import { generateSchoolTokens } from "./services";

const schoolAuthRouter = new Hono<SchoolEnv>();

// ==================== Signup (First user = SCHOOL_OWNER, add school details) ====================
const signupSchema = z.object({
  schoolCode: z.string(),
  ownerName: z.string().min(2),
  ownerEmail: z.string().email(), // Owner's email (also used for login)
  ownerPassword: z.string().min(8),
  ownerPhone: z.string().optional(), // Owner's contact phone
  ownerAlternatePhone: z.string().optional(), // Optional second phone number (Alternate Owner contact phone)
  schoolName: z.string().min(3),
  addressLineOne: z.string(), // School address line 1
  addressLineTwo: z.string().optional(), // School address line 2
  phone: z.string().optional(), // School contact phone
  alternatePhone: z.string().optional(), // Optional second phone number (Alternate School contact phone)
  schoolEmail: z.string().email().optional(),
  schoolWebsite: z.string().url().optional(),
});

schoolAuthRouter.post(
  "/signup",
  zValidator("json", signupSchema),
  async (c) => {
    console.log("Handling school signup request");
    try {
      const data = c.req.valid("json");
      const {
        schoolCode,
        ownerName,
        ownerEmail,
        ownerPassword,
        ownerPhone,
        ownerAlternatePhone,
        schoolName,
        addressLineOne,
        addressLineTwo,
        phone,
        alternatePhone,
        schoolEmail,
        schoolWebsite,
      } = data;
      const db = await getSchoolDB(c.env, schoolCode);

      console.log("Checking if school already registered");

      // Check if school already registered (schools table has record)
      const existingSchool = await db.select().from(schoolsSchema).get();
      if (existingSchool)
        return c.json(
          { error: "School already registered. Please log in." },
          400
        );

      console.log("Checking if email already in use");

      // Check user email unique
      const existingUser = await db
        .select()
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.email, ownerEmail))
        .get();
      if (existingUser) return c.json({ error: "Email already in use" }, 400);

      console.log("Hashing password");

      const passwordHash = await hashPassword(ownerPassword);

      // Insert OWNER user
      const [newUser] = await db
        .insert(schoolUsersSchema)
        .values({
          name: ownerName,
          email: ownerEmail,
          passwordHash,
          role: SchoolRole.SCHOOL_OWNER,
          phone: ownerPhone ?? "",
          alternatePhone: ownerAlternatePhone ?? "",
          isActive: true,
        })
        .returning();

      // Insert school record (id defaults to 1)
      await db.insert(schoolsSchema).values({
        name: schoolName,
        uniqueCode: schoolCode,
        addressLineOne: addressLineOne ?? "",
        addressLineTwo: addressLineTwo ?? "",
        phone: phone ?? "",
        alternatePhone: alternatePhone ?? "",
        email: schoolEmail,
        website: schoolWebsite ?? "",
        isActive: true,
      });

      // Generate tokens
      const access_token = await generateSchoolAccessToken(
        { id: newUser.id, name: newUser.name, role: newUser.role, schoolCode },
        c.env.JWT_SECRET
      );

      const refresh_token = await generateSchoolRefreshToken(db, newUser.id);

      return c.json({
        access_token,
        refresh_token,
        user: {
          id: newUser.id,
          name: newUser.name,
          role: newUser.role,
          schoolCode,
        },
      });
    } catch (error: any) {
      console.error(error);
      return c.json(
        { error: error.message || "Signup failed. Please contact support." },
        400
      );
    }
  }
);

// ==================== Login ====================
const loginSchema = z.object({
  schoolCode: z.string(),
  email: z.string().email(),
  password: z.string(),
});

schoolAuthRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  try {
    const { schoolCode, email, password } = c.req.valid("json");
    const db = await getSchoolDB(c.env, schoolCode);

    const user = await db
      .select()
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.email, email))
      .get();

    if (!user || !(await comparePassword(password, user.passwordHash))) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const access_token = await generateSchoolAccessToken(
      { id: user.id, name: user.name, role: user.role, schoolCode },
      c.env.JWT_SECRET
    );

    const refresh_token = await generateSchoolRefreshToken(db, user.id);

    return c.json({
      access_token,
      refresh_token,
      user: { id: user.id, name: user.name, role: user.role, schoolCode },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 401);
  }
});

// ==================== REFRESH TOKEN ====================
const refreshSchema = z.object({ refresh_token: z.string() });

schoolAuthRouter.post(
  "/refresh",
  zValidator("json", refreshSchema),
  async (c) => {
    try {
      const { refresh_token } = c.req.valid("json");
      const schoolCode = c.get("schoolCode") || c.req.header("X-School-Code"); // Fallback for safety
      if (!schoolCode) return c.json({ error: "School code missing" }, 400);

      const db = await getSchoolDB(c.env, schoolCode);

      const payload = await validateSchoolRefreshToken(db, refresh_token);
      if (!payload)
        return c.json({ error: "Invalid or expired refresh token" }, 401);

      const user = await db
        .select()
        .from(schoolUsersSchema)
        .where(eq(schoolUsersSchema.id, payload.userId))
        .get();

      if (!user) return c.json({ error: "User not found" }, 404);

      // Generate NEW tokens (old refresh is deleted inside generateSchoolTokens)
      const { access_token, refresh_token: newRefreshToken } =
        await generateSchoolTokens(
          db,
          { id: user.id, name: user.name, role: user.role, schoolCode },
          c.env.JWT_SECRET
        );

      return c.json({ access_token, refresh_token: newRefreshToken });
    } catch (error: any) {
      return c.json({ error: error.message || "Refresh failed" }, 401);
    }
  }
);

// ==================== LOGOUT ====================
const logoutSchema = z.object({ refresh_token: z.string() });

schoolAuthRouter.post(
  "/logout",
  zValidator("json", logoutSchema),
  async (c) => {
    try {
      const { refresh_token } = c.req.valid("json");
      const schoolCode = c.get("schoolCode");
      if (!schoolCode) return c.json({ message: "Logged out" }); // Graceful

      const db = await getSchoolDB(c.env, schoolCode);
      await db
        .delete(schoolRefreshTokensSchema)
        .where(eq(schoolRefreshTokensSchema.token, refresh_token));

      return c.json({ message: "Logged out successfully" });
    } catch {
      return c.json({ message: "Logged out" }); // Always succeed on client
    }
  }
);

export default schoolAuthRouter;
