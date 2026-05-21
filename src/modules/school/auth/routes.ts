// Backend .../school/auth/routes.ts
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  getCommonDB,
  paymentConfigSchema,
  schoolInvitationsSchema,
  schoolPaymentRecordsSchema,
  schoolsSchema as superSchoolsSchema,
} from "../../../db";
import {
  schoolRefreshTokensSchema,
  schoolsSchema,
  schoolThemeConfigsSchema,
} from "../../../db/schemas/school";
import { schoolUsersSchema } from "../../../db/schemas/school/school-users";
import { getSchoolDB } from "../../../db/school-client";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { SchoolEnv } from "../../../types/common-types";
import { SchoolRole } from "../../../types/school-role";
import { comparePassword, hashPassword } from "../../../utils/hashing";
import { validateSchoolRefreshToken } from "../../../utils/school/tokens";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { getParentChildren } from "../parent/services";
import {
  getUserPermissionsFromDB,
  getUserWithPermissions,
} from "./permission-helpers";
import { generateSchoolTokens, validateSchoolCode } from "./services";

const schoolAuthRouter = new Hono<SchoolEnv>();

// const FRONTEND_URL = "http://localhost:4200";

const getFrontendUrl = (c: { env: SchoolEnv["Bindings"] }): string =>
  c.env.FRONTEND_ORIGIN || "http://localhost:4200";

interface SchoolBranding {
  name: string;
  shortName: string | null;
  addressLineOne: string;
  addressLineTwo: string;
  phone: string;
  alternatePhone: string;
  email: string;
  logoUrl: string | null;
  tagline: string | null;
  theme: {
    themeName: string;
    config: Record<string, string>;
    isCustomTheme: boolean;
  } | null;
}

async function fetchSchoolBranding(db: any): Promise<SchoolBranding | null> {
  try {
    // Single query with LEFT JOIN — was 2 sequential round trips, now 1
    const row = await db
      .select({
        name: schoolsSchema.name,
        shortName: schoolsSchema.shortName,
        addressLineOne: schoolsSchema.addressLineOne,
        addressLineTwo: schoolsSchema.addressLineTwo,
        phone: schoolsSchema.phone,
        alternatePhone: schoolsSchema.alternatePhone,
        email: schoolsSchema.email,
        logoUrl: schoolsSchema.logoUrl,
        tagline: schoolsSchema.tagline,
        // Theme via LEFT JOIN — null if no active theme
        themeName: schoolThemeConfigsSchema.themeName,
        themeConfig: schoolThemeConfigsSchema.config,
        isCustomTheme: schoolThemeConfigsSchema.isCustomTheme,
      })
      .from(schoolsSchema)
      .leftJoin(
        schoolThemeConfigsSchema,
        and(
          eq(schoolThemeConfigsSchema.schoolId, schoolsSchema.id),
          eq(schoolThemeConfigsSchema.isActive, true)
        )
      )
      .get();

    if (!row) return null;

    return {
      name: row.name,
      shortName: row.shortName || null,
      addressLineOne: row.addressLineOne ?? "",
      addressLineTwo: row.addressLineTwo ?? "",
      phone: row.phone ?? "",
      alternatePhone: row.alternatePhone ?? "",
      email: row.email ?? "",
      logoUrl: row.logoUrl || null,
      tagline: row.tagline || null,
      theme: row.themeName
        ? {
            themeName: row.themeName,
            config: JSON.parse(row.themeConfig || "{}"),
            isCustomTheme: row.isCustomTheme,
          }
        : null,
    };
  } catch {
    return null; // Non-fatal — login still succeeds without branding
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── endpoint GET /school/auth/registration-details/:schoolCode ─
// Add this route in …/school/auth/routes.ts BEFORE the protected middleware.
// It allows the payment page to fetch registration details via school code
// when the invite token is not available in the URL.
// ─────────────────────────────────────────────────────────────────────────────

// GET /school/auth/registration-details/:schoolCode
// Public — returns stored owner/school details (strips passwordHash for safety).
// Used by the payment page to show what was submitted during signup.
schoolAuthRouter.get("/registration-details/:schoolCode", async (c) => {
  try {
    const schoolCode = c.req.param("schoolCode")?.trim().toUpperCase();
    if (!schoolCode) {
      return c.json({ success: false, error: "School code required" }, 400);
    }

    const commonDb = getCommonDB(c.env);

    // Look up the school to get its ID
    const school = await commonDb
      .select({ id: superSchoolsSchema.id, name: superSchoolsSchema.name })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();

    if (!school) {
      return c.json({ success: false, error: "School not found" }, 404);
    }

    // Find the most recent invitation for this school
    const invitation = await commonDb
      .select()
      .from(schoolInvitationsSchema)
      .where(eq(schoolInvitationsSchema.schoolId, school.id))
      .orderBy(sql`${schoolInvitationsSchema.createdAt} DESC`)
      .get();

    if (!invitation) {
      return c.json({ success: false, error: "No invitation found" }, 404);
    }

    // Parse and sanitize the stored registration data
    let registeredDetails: Record<string, unknown> | null = null;
    if (invitation.notes) {
      try {
        const parsed = JSON.parse(invitation.notes);
        // SECURITY: Strip passwordHash — never expose to frontend
        const { passwordHash, ...safeDetails } = parsed;
        registeredDetails = safeDetails;
      } catch {
        // Non-critical
      }
    }

    return c.json({
      success: true,
      details: registeredDetails,
      inviteToken: invitation.inviteToken, // return token so frontend can use edit flow
    });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ==================== VALIDATE SCHOOL CODE ====================
schoolAuthRouter.get("/validate-school-code/:schoolCode", async (c) => {
  try {
    const schoolCode = c.req.param("schoolCode")?.trim().toUpperCase();

    if (!schoolCode || schoolCode.length < 3) {
      return c.json({ valid: false, error: "School code is required" }, 400);
    }

    // ── Step 1: Check super DB first ──────────────────────────────────────
    // This avoids calling getSchoolDB on a code that doesn't exist,
    // which throws "School not found" and causes a 500.
    const commonDb = getCommonDB(c.env);
    const superSchool = await commonDb
      .select({
        uniqueCode: superSchoolsSchema.uniqueCode,
        isActive: superSchoolsSchema.isActive,
        onboardingStatus: superSchoolsSchema.onboardingStatus,
      })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();

    if (!superSchool) {
      return c.json(
        {
          valid: false,
          error: "School code not found. Please check and try again.",
        },
        404
      );
    }

    if (!superSchool.isActive) {
      return c.json(
        { valid: false, error: "This school account is not yet active." },
        403
      );
    }

    // ── Step 2: Now safe to connect to school DB ──────────────────────────
    const db = await getSchoolDB(c.env, schoolCode);
    const result = await validateSchoolCode(db, schoolCode);

    if (!result.valid) {
      return c.json(
        { valid: false, error: result.error || "Validation failed" },
        (result.statusCode as any) || 400
      );
    }

    return c.json({
      valid: true,
      school: {
        name: result.school!.name,
        code: result.school!.uniqueCode,
        logoUrl: result.school!.logoUrl || null,
        tagline: result.school!.tagline || null,
        theme: result.school!.theme || null,
      },
      message: "School code is valid",
    });
  } catch (error: any) {
    console.error("Validate school code route error:", error);
    return c.json(
      { valid: false, error: "Internal server error. Please try again later." },
      500
    );
  }
});

// ==================== VALIDATE INVITE TOKEN (PUBLIC) ====================
// ── Returns schoolCode + paymentStatus for already-registered schools
//    so the frontend can redirect straight to /school/payment?code=...
//    instead of re-showing the registration form.
schoolAuthRouter.get("/validate-invite/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const commonDb = getCommonDB(c.env);

    const invitation = await commonDb
      .select()
      .from(schoolInvitationsSchema)
      .where(eq(schoolInvitationsSchema.inviteToken, token))
      .get();

    if (!invitation) {
      return c.json({ valid: false, error: "Invitation not found" }, 404);
    }
    if (["EXPIRED", "CANCELLED"].includes(invitation.status)) {
      return c.json(
        { valid: false, error: "Invitation has expired or been cancelled" },
        410
      );
    }
    if (new Date(invitation.expiresAt) < new Date()) {
      return c.json(
        { valid: false, error: "Invitation link has expired" },
        410
      );
    }

    // ── Already registered: redirect to payment page ───────────────────────
    // If the school already completed the signup form (status = REGISTERED or
    // PAYMENT_SUBMITTED), return a special response so the frontend skips the
    // form and goes straight to /school/payment?code=...
    if (
      invitation.status === "REGISTERED" ||
      invitation.status === "PAYMENT_SUBMITTED"
    ) {
      // Fetch the school code from the schools table
      let schoolCode: string | null = null;
      if (invitation.schoolId) {
        const school = await commonDb
          .select({ uniqueCode: superSchoolsSchema.uniqueCode })
          .from(superSchoolsSchema)
          .where(eq(superSchoolsSchema.id, invitation.schoolId))
          .get();
        schoolCode = school?.uniqueCode ?? null;
      }

      // ── NEW: parse stored owner registration data from invitation.notes ──────
      // notes contains JSON with ownerName, ownerEmail, ownerPhone, schoolName,
      // addressLineOne, etc. — but NOT the passwordHash (we strip it for safety).
      let registeredDetails: Record<string, string> | null = null;
      if (invitation.notes) {
        try {
          const parsed = JSON.parse(invitation.notes);
          // Strip passwordHash — never expose it to the frontend
          const { passwordHash, ...safeDetails } = parsed;
          registeredDetails = safeDetails;
        } catch {
          // Non-critical — leave as null
        }
      }

      return c.json({
        valid: true,
        alreadyRegistered: true, // ← NEW flag the frontend checks
        schoolCode, // ← NEW: school code for payment page redirect
        registeredDetails, // safe owner+school details for pre-filling edit form
        invitation: {
          token: invitation.inviteToken,
          schoolName: invitation.schoolName,
          schoolEmail: invitation.schoolEmail,
          schoolPhone: invitation.schoolPhone,
          city: invitation.city,
          status: invitation.status,
          schoolId: invitation.schoolId,
          expiresAt: invitation.expiresAt,
        },
      });
    }

    // ── Already active ─────────────────────────────────────────────────────
    if (invitation.status === "PAYMENT_APPROVED") {
      return c.json(
        { valid: false, error: "School is already registered and active" },
        409
      );
    }

    // ── Fresh invitation — return full payload including payment config ─────
    const feeConfig = await commonDb
      .select({
        setupFeeAmount: paymentConfigSchema.setupFeeAmount,
        isFeeEnabled: paymentConfigSchema.isFeeEnabled,
        upiId: paymentConfigSchema.upiId,
        qrCodeUrl: paymentConfigSchema.qrCodeUrl,
        feeDescription: paymentConfigSchema.feeDescription,
      })
      .from(paymentConfigSchema)
      .where(eq(paymentConfigSchema.id, 1))
      .get();

    return c.json({
      valid: true,
      alreadyRegistered: false,
      invitation: {
        token: invitation.inviteToken,
        schoolName: invitation.schoolName,
        schoolEmail: invitation.schoolEmail,
        schoolPhone: invitation.schoolPhone,
        city: invitation.city,
        status: invitation.status,
        schoolId: invitation.schoolId,
        expiresAt: invitation.expiresAt,
      },
      paymentConfig: feeConfig ?? {
        setupFeeAmount: 0,
        isFeeEnabled: false,
        upiId: "",
        qrCodeUrl: "",
        feeDescription: "",
      },
    });
  } catch (error: any) {
    console.error("validate-invite error:", error);
    return c.json({ valid: false, error: "Internal server error." }, 500);
  }
});

// ==================== GET PAYMENT STATUS ====================
schoolAuthRouter.get("/payment-status/:schoolCode", async (c) => {
  try {
    const schoolCode = c.req.param("schoolCode");
    const commonDb = getCommonDB(c.env);

    const school = await commonDb
      .select({
        id: superSchoolsSchema.id,
        name: superSchoolsSchema.name,
        onboardingStatus: superSchoolsSchema.onboardingStatus,
        isActive: superSchoolsSchema.isActive,
        email: superSchoolsSchema.email,
      })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();

    if (!school) return c.json({ error: "School not found" }, 404);

    // paymentRecord and feeConfig are independent — fetch both at once
    const [paymentRecord, feeConfig] = await Promise.all([
      commonDb
        .select()
        .from(schoolPaymentRecordsSchema)
        .where(eq(schoolPaymentRecordsSchema.schoolId, school.id))
        .orderBy(sql`${schoolPaymentRecordsSchema.createdAt} DESC`)
        .get(),

      commonDb
        .select()
        .from(paymentConfigSchema)
        .where(eq(paymentConfigSchema.id, 1))
        .get(),
    ]);

    return c.json({
      success: true,
      school: {
        name: school.name,
        onboardingStatus: school.onboardingStatus,
        isActive: school.isActive,
      },
      paymentRecord: paymentRecord ?? null,
      paymentConfig: feeConfig ?? null,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ==================== SUBMIT PAYMENT PROOF ====================
const submitPaymentSchema = z.object({
  schoolCode: z.string(),
  utrNumber: z.string().min(6).max(30),
  payerName: z.string().min(2),
  payerPhone: z.string().optional(),
  screenshotUrl: z.string().url().optional().or(z.literal("")),
  amountPaid: z.number().int().positive(), // in paise
});

schoolAuthRouter.post(
  "/submit-payment",
  zValidator("json", submitPaymentSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const commonDb = getCommonDB(c.env);

      const school = await commonDb
        .select()
        .from(superSchoolsSchema)
        .where(eq(superSchoolsSchema.uniqueCode, data.schoolCode))
        .get();

      if (!school) return c.json({ error: "School not found" }, 404);

      if (
        !["REGISTERED", "PAYMENT_SUBMITTED"].includes(school.onboardingStatus)
      ) {
        return c.json(
          { error: "School is not in a state to submit payment" },
          400
        );
      }

      const invitation = await commonDb
        .select()
        .from(schoolInvitationsSchema)
        .where(eq(schoolInvitationsSchema.schoolId, school.id))
        .orderBy(sql`${schoolInvitationsSchema.createdAt} DESC`)
        .get();

      if (!invitation) {
        return c.json({ error: "No invitation found for this school" }, 404);
      }

      const feeConfig = await commonDb
        .select({ setupFeeAmount: paymentConfigSchema.setupFeeAmount })
        .from(paymentConfigSchema)
        .where(eq(paymentConfigSchema.id, 1))
        .get();

      await commonDb.transaction(async (tx: any) => {
        const existingRecord = await tx
          .select({ id: schoolPaymentRecordsSchema.id })
          .from(schoolPaymentRecordsSchema)
          .where(eq(schoolPaymentRecordsSchema.schoolId, school.id))
          .orderBy(sql`${schoolPaymentRecordsSchema.createdAt} DESC`)
          .get();

        if (existingRecord) {
          await tx
            .update(schoolPaymentRecordsSchema)
            .set({
              utrNumber: data.utrNumber,
              payerName: data.payerName,
              payerPhone: data.payerPhone || "",
              screenshotUrl: data.screenshotUrl || "",
              amountPaid: data.amountPaid,
              status: "SUBMITTED",
              submittedAt: new Date().toISOString(),
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(eq(schoolPaymentRecordsSchema.id, existingRecord.id));
        } else {
          await tx.insert(schoolPaymentRecordsSchema).values({
            schoolId: school.id,
            invitationId: invitation.id,
            amountExpected: feeConfig?.setupFeeAmount ?? 0,
            amountPaid: data.amountPaid,
            utrNumber: data.utrNumber,
            payerName: data.payerName,
            payerPhone: data.payerPhone || "",
            screenshotUrl: data.screenshotUrl || "",
            status: "SUBMITTED",
            submittedAt: new Date().toISOString(),
          });
        }

        await tx
          .update(superSchoolsSchema)
          .set({
            onboardingStatus: "PAYMENT_SUBMITTED",
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(superSchoolsSchema.id, school.id));

        await tx
          .update(schoolInvitationsSchema)
          .set({
            status: "PAYMENT_SUBMITTED",
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(schoolInvitationsSchema.id, invitation.id));
      });

      // Notify super admin
      const notifyEmail: BrevoSendEmailRequest = {
        sender: {
          email: c.env.BREVO_SENDER_EMAIL,
          name: c.env.BREVO_SENDER_NAME,
        },
        to: [{ email: c.env.BREVO_SENDER_EMAIL, name: "SMS Admin" }],
        subject: `💰 New Payment Submitted — ${school.name}`,
        htmlContent: `
          <p><strong>${school.name}</strong> has submitted payment proof.</p>
          <p>UTR: <strong>${data.utrNumber}</strong></p>
          <p>Amount: <strong>₹${(data.amountPaid / 100).toLocaleString(
            "en-IN"
          )}</strong></p>
          <p>Payer: ${data.payerName}</p>
          <p>Login to your admin portal to verify and approve.</p>
        `,
      };
      sendTransactionalEmail(c.env, notifyEmail).catch(console.error);

      return c.json({
        success: true,
        message:
          "Payment submitted successfully. Our team will verify within 24 hours.",
      });
    } catch (error: any) {
      console.error("submit-payment error:", error);
      return c.json(
        { error: error.message || "Failed to submit payment" },
        500
      );
    }
  }
);

// ==================== SIGNUP (via invite token — stores data in super DB only) ====================
/**
 * IMPORTANT DESIGN DECISION:
 *
 * At signup time, the school's Turso DB has NOT been provisioned yet.
 * DB provisioning happens in the approvals service AFTER payment is confirmed.
 *
 * So at signup we:
 *  1. Validate the invite token
 *  2. Hash the password and store ALL owner data securely in the invitation record
 *  3. Mark the school as REGISTERED in the super DB
 *  4. Redirect school to the payment page
 *
 * When super admin approves payment, the approvals service reads the stored
 * owner data and fully provisions the school DB (users, roles, permissions, themes).
 */
const signupSchema = z.object({
  inviteToken: z.string().uuid(),
  ownerName: z.string().min(2),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  ownerPhone: z.string().optional(),
  ownerAlternatePhone: z.string().optional(),
  schoolName: z.string().min(3),
  addressLineOne: z.string(),
  addressLineTwo: z.string().optional(),
  phone: z.string().optional(),
  alternatePhone: z.string().optional(),
  schoolEmail: z.string().email().optional(),
  schoolWebsite: z.string().url().optional(),
  /**
   * Owner must agree to T&C and Privacy Policy at signup.
   * Required: true — cannot register without accepting.
   */
  termsAccepted: z.literal(true, {
    message:
      "You must accept the Terms & Conditions and Privacy Policy to register.",
  }),
});

schoolAuthRouter.post(
  "/signup",
  zValidator("json", signupSchema),
  async (c) => {
    try {
      const data = c.req.valid("json");
      const commonDb = getCommonDB(c.env);

      // 1. Validate invitation token
      const invitation = await commonDb
        .select()
        .from(schoolInvitationsSchema)
        .where(eq(schoolInvitationsSchema.inviteToken, data.inviteToken))
        .get();

      if (!invitation) {
        return c.json({ error: "Invalid invitation token" }, 400);
      }
      if (["EXPIRED", "CANCELLED"].includes(invitation.status)) {
        return c.json(
          { error: "This invitation has expired or been cancelled" },
          410
        );
      }
      if (invitation.status === "PAYMENT_APPROVED") {
        return c.json(
          { error: "School already registered. Please log in." },
          409
        );
      }
      if (invitation.status === "REGISTERED") {
        // Already registered — just redirect to payment
        const superSchool = await commonDb
          .select({ uniqueCode: superSchoolsSchema.uniqueCode })
          .from(superSchoolsSchema)
          .where(eq(superSchoolsSchema.id, invitation.schoolId!))
          .get();
        return c.json({
          success: true,
          message: "Already registered. Please complete your payment.",
          schoolCode: superSchool?.uniqueCode,
          onboardingStatus: "REGISTERED",
          nextStep: "payment",
        });
      }
      if (new Date(invitation.expiresAt) < new Date()) {
        return c.json(
          { error: "Invitation link has expired. Please contact support." },
          410
        );
      }
      if (!invitation.schoolId) {
        return c.json(
          { error: "Invalid invitation: no school record found" },
          400
        );
      }

      // 2. Fetch school record
      const superSchool = await commonDb
        .select()
        .from(superSchoolsSchema)
        .where(eq(superSchoolsSchema.id, invitation.schoolId))
        .get();

      if (!superSchool) {
        return c.json(
          { error: "School record not found. Please contact support." },
          400
        );
      }

      const schoolCode = superSchool.uniqueCode;

      // 3. SECURITY: Hash the password before storing — NEVER store plaintext
      const passwordHash = await hashPassword(data.ownerPassword);

      // 4. Store owner registration data (with hashed password) in invitation notes
      // This data will be read by the approvals service when provisioning the school DB
      const ownerRegistrationData = JSON.stringify({
        ownerName: data.ownerName,
        ownerEmail: data.ownerEmail,
        passwordHash, // Securely hashed — safe to store
        ownerPhone: data.ownerPhone || "",
        ownerAlternatePhone: data.ownerAlternatePhone || "",
        schoolName: data.schoolName,
        addressLineOne: data.addressLineOne,
        addressLineTwo: data.addressLineTwo || "",
        phone: data.phone || "",
        alternatePhone: data.alternatePhone || "",
        schoolEmail: data.schoolEmail || "",
        schoolWebsite: data.schoolWebsite || "",
        registeredAt: new Date().toISOString(),
        // T&C acceptance — the approvals service writes this into
        // the provisioned school_users record at activation time.
        termsAcceptedAt: new Date().toISOString(),
      });

      // 5. Update super DB records
      await commonDb.transaction(async (tx: any) => {
        // Update school record with form data
        await tx
          .update(superSchoolsSchema)
          .set({
            name: data.schoolName,
            phone: data.phone || superSchool.phone,
            addressLineOne: data.addressLineOne,
            addressLineTwo: data.addressLineTwo || "",
            onboardingStatus: "REGISTERED",
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(superSchoolsSchema.id, invitation.schoolId!));

        // Mark invitation as REGISTERED and store owner data
        await tx
          .update(schoolInvitationsSchema)
          .set({
            status: "REGISTERED",
            registeredAt: new Date().toISOString(),
            notes: ownerRegistrationData, // hashed password — safe
            ownerTermsAcceptedAt: new Date().toISOString(),
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(schoolInvitationsSchema.id, invitation.id));
      });

      // 6. Send payment instructions email
      const frontendUrl = getFrontendUrl(c);
      const paymentPageUrl = `${frontendUrl}/school/payment?code=${schoolCode}`;
      const confirmEmail: BrevoSendEmailRequest = {
        sender: {
          email: c.env.BREVO_SENDER_EMAIL,
          name: c.env.BREVO_SENDER_NAME,
        },
        to: [{ email: data.ownerEmail, name: data.ownerName }],
        subject: "Registration received — complete your payment to activate",
        htmlContent: `
          <!DOCTYPE html><html lang="en"><head>
          <style>
            body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
            .c{max-width:600px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
            .h{background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:40px 32px;text-align:center;color:white}
            .h h1{margin:0;font-size:24px;font-weight:700}
            .b{padding:32px}.b p{color:#374151;font-size:15px;line-height:1.6}
            .cta{text-align:center;margin:32px 0}
            .cta a{display:inline-block;padding:14px 36px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px}
            .info-box{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0}
            .f{padding:24px;border-top:1px solid #f3f4f6;text-align:center;color:#9ca3af;font-size:13px}
          </style>
          </head><body>
          <div class="c">
            <div class="h"><h1>Step 2: Complete Your Payment</h1></div>
            <div class="b">
              <p>Hi <strong>${data.ownerName}</strong>,</p>
              <p>Thank you for registering <strong>${data.schoolName}</strong>! Your account details have been saved.</p>
              <p>To activate your account, please complete the setup fee payment. Our team will verify and activate your account within 24 hours after payment confirmation.</p>
              <div class="info-box">
                <p style="margin:0;font-size:14px"><strong>Your School Code:</strong> ${schoolCode}</p>
                <p style="margin:8px 0 0;font-size:13px;color:#0369a1">Keep this safe — you'll need it to log in after activation.</p>
              </div>
              <div class="cta"><a href="${paymentPageUrl}">Complete Payment →</a></div>
              <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy this link:<br>${paymentPageUrl}</p>
            </div>
            <div class="f"><p>Best regards, SMS Team</p></div>
          </div>
          </body></html>
        `,
      };
      sendTransactionalEmail(c.env, confirmEmail).catch(console.error);

      return c.json({
        success: true,
        message:
          "Registration successful! Please complete your payment to activate your account.",
        schoolCode,
        onboardingStatus: "REGISTERED",
        nextStep: "payment",
        paymentPageUrl,
      });
    } catch (error: any) {
      console.error("Signup error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Signup failed. Please contact support.",
        },
        400
      );
    }
  }
);

// ==================== LOGIN SCHEMA ====================
const loginSchema = z.object({
  schoolCode: z
    .string()
    .min(3)
    .max(50)
    .transform((val) => val.toUpperCase().trim()),
  email: z
    .string()
    .email()
    .transform((val) => val.toLowerCase().trim()),
  password: z.string().min(1, "Password is required"),

  /**
   * True when the user has checked "I agree to T&C and Privacy Policy"
   * on the login form. Only required on first login (when termsAcceptedAt is NULL).
   * Optional on subsequent logins — existing acceptance is preserved.
   */
  termsAccepted: z.boolean().optional(),
});

// ==================== LOGIN ====================
schoolAuthRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  try {
    const { schoolCode, email, password, termsAccepted } = c.req.valid("json");

    // Check onboarding status first to give meaningful errors
    const commonDb = getCommonDB(c.env);
    const superSchool = await commonDb
      .select({
        onboardingStatus: superSchoolsSchema.onboardingStatus,
        isActive: superSchoolsSchema.isActive,
      })
      .from(superSchoolsSchema)
      .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
      .get();

    if (superSchool && !superSchool.isActive) {
      const status = superSchool.onboardingStatus;
      if (status === "REGISTERED" || status === "INVITED") {
        return c.json(
          {
            success: false,
            error:
              "Your account is not yet activated. Please complete payment first.",
            onboardingStatus: status,
            requiresPayment: true,
          },
          403
        );
      }
      if (status === "PAYMENT_SUBMITTED") {
        return c.json(
          {
            success: false,
            error:
              "Your payment is being verified. You will be notified once activated.",
            onboardingStatus: status,
            paymentPending: true,
          },
          403
        );
      }
    }

    const db = await getSchoolDB(c.env, schoolCode);

    const user = await db
      .select({
        id: schoolUsersSchema.id,
        name: schoolUsersSchema.name,
        email: schoolUsersSchema.email,
        primaryRole: schoolUsersSchema.primaryRole,
        isActive: schoolUsersSchema.isActive,
        passwordHash: schoolUsersSchema.passwordHash,
        tokenVersion: schoolUsersSchema.tokenVersion,
        termsAcceptedAt: schoolUsersSchema.termsAcceptedAt,
      })
      .from(schoolUsersSchema)
      .where(eq(schoolUsersSchema.email, email))
      .get();

    if (!user)
      return c.json(
        { success: false, error: "Invalid email or password" },
        401
      );
    if (!user.isActive)
      return c.json({ success: false, error: "Account deactivated" }, 403);

    const isPasswordValid = await comparePassword(password, user.passwordHash);
    if (!isPasswordValid)
      return c.json(
        { success: false, error: "Invalid email or password" },
        401
      );

    // ── T&C enforcement ─────────────────────────────────────────────────────
    // If the user has never accepted T&C, they must do so now.
    const isFirstTimeAcceptance = !user.termsAcceptedAt;

    if (isFirstTimeAcceptance && !termsAccepted) {
      return c.json(
        {
          success: false,
          error:
            "You must accept the Terms & Conditions and Privacy Policy to continue.",
          requiresTermsAcceptance: true,
        },
        403
      );
    }

    // If this is a first-time acceptance, record it immediately
    if (isFirstTimeAcceptance && termsAccepted) {
      await db
        .update(schoolUsersSchema)
        .set({ termsAcceptedAt: new Date().toISOString() })
        .where(eq(schoolUsersSchema.id, user.id));
    }

    // Optimising from here
    // === FETCH USER PERMISSIONS  ===
    // Step 1: permissions (internally uses db.batch — 2 round trips total)
    const userPermissions = await getUserPermissionsFromDB(db, user.id);

    // Step 2: primaryRole — read directly from the user row we already fetched.
    // user.primaryRole is already on the user object from the SELECT above,
    // so NO extra round trip needed here at all.
    const roleName = user.primaryRole ?? "";

    // Step 3+4 in parallel: generate tokens AND fetch branding simultaneously.
    // Token generation (JWT sign + refresh token DB insert) and branding read
    // are completely independent — run them at the same time.
    const [{ access_token, refresh_token }, school] = await Promise.all([
      generateSchoolTokens(
        db,
        {
          id: user.id,
          name: user.name,
          email: user.email,
          schoolCode,
          permissions: userPermissions,
          tokenVersion: user.tokenVersion,
          role: roleName,
        },
        c.env.JWT_SECRET
      ),
      fetchSchoolBranding(db),
    ]);

    // ── Typed child shape ──────────────────────────────────────────────────
    // Fetch children for STUDENT_PARENT — strongly typed to avoid ts(2589)
    type ChildItem = {
      studentId: number;
      studentName: string;
      studentEmail: string;
      studentAvatarUrl: string | undefined;
      relationship: string;
      isPrimary: boolean;
      currentEnrollment: {
        enrollmentId: number;
        className: string;
        sectionName: string;
        rollNumber: string | undefined;
        academicYearName: string;
        isActive: boolean;
      } | null;
    };

    // ── Fetch children if user is a STUDENT_PARENT ──────────────
    let children: ChildItem[] | null = null;
    if (roleName === SchoolRole.STUDENT_PARENT) {
      try {
        children = (await getParentChildren(
          c.env,
          schoolCode,
          user.id
        )) as ChildItem[];
      } catch (err) {
        console.error("Failed to fetch parent children on login:", err);
        children = [];
      }
    }

    // Explicit typed object — avoids Hono's infinite generic instantiation
    const responseBody: {
      success: boolean;
      message: string;
      access_token: string;
      refresh_token: string;
      user: { id: number; name: string; email: string; schoolCode: string };
      children: ChildItem[] | null;
      role: string;
      requiresTermsAcceptance: boolean;
      school: SchoolBranding | null;
    } = {
      success: true,
      message: "Login successful",
      access_token,
      refresh_token,
      user: { id: user.id, name: user.name, email: user.email, schoolCode },
      children,
      role: roleName,
      requiresTermsAcceptance: false,
      school,
    };
    return c.json(responseBody);
  } catch (error: any) {
    console.error("School login error:", error);
    return c.json({ success: false, error: "Login failed" }, 500);
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
      const schoolCode = c.get("schoolCode") || c.req.header("X-School-Code");

      if (!schoolCode) {
        return c.json({ error: "School code missing" }, 400);
      }

      const db = await getSchoolDB(c.env, schoolCode);

      // Step 1: validate refresh token (must happen first — gates everything)
      const payload = await validateSchoolRefreshToken(db, refresh_token);
      if (!payload) {
        return c.json({ error: "Invalid or expired refresh token" }, 401);
      }

      // Step 2: getUserWithPermissions now uses db.batch internally.
      // It fetches user + roles + denials + directPerms in ONE round trip,
      // then rolePerms in a second. It also returns primaryRole directly
      // from school_users — no extra query needed.
      const userWithPermissions = await getUserWithPermissions(
        db,
        payload.userId
      );

      if (!userWithPermissions) {
        return c.json({ error: "User not found" }, 404);
      }
      if (!userWithPermissions.isActive) {
        return c.json({ error: "Account deactivated" }, 403);
      }

      // primaryRole now comes from getUserWithPermissions — no extra DB call
      const role = userWithPermissions.primaryRole ?? "";

      // Step 3+4 in parallel: generate new tokens AND fetch branding together.
      // These are completely independent — run simultaneously.
      const [{ access_token, refresh_token: newRefreshToken }, school] =
        await Promise.all([
          generateSchoolTokens(
            db,
            {
              id: userWithPermissions.id,
              name: userWithPermissions.name,
              email: userWithPermissions.email,
              schoolCode,
              permissions: userWithPermissions.permissions as string[],
              tokenVersion: userWithPermissions.tokenVersion,
              role,
            },
            c.env.JWT_SECRET
          ),
          fetchSchoolBranding(db),
        ]);

      return c.json({
        success: true,
        access_token,
        refresh_token: newRefreshToken,
        school,
      });
    } catch (error: any) {
      console.error("Refresh token error:", error);
      return c.json(
        {
          success: false,
          error: error.message || "Refresh failed",
        },
        401
      );
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
