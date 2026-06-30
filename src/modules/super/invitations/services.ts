// src/modules/super/invitations/services.ts

import { eq, desc, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { schoolInvitationsSchema } from "../../../db/schemas/super/school-invitations";
import { schoolsSchema } from "../../../db/schemas/super/schools";
import { paymentConfigSchema } from "../../../db/schemas/super/payment-config";
import { superUsersSchema } from "../../../db/schemas/super/super-users";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { BrevoSendEmailRequest } from "../../../types/brevo";

// const FRONTEND_URL = "http://localhost:4200"; 

// Helper function to get Frontend URL from environment
const getFrontendUrl = (env: { FRONTEND_ORIGIN?: string }): string => {
  return env.FRONTEND_ORIGIN || "http://localhost:4200";
};

// ── School code generation ────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SCHOOL_CODE_LENGTH = 7;
const MAX_GENERATION_ATTEMPTS = 10;

const generateRandomCode = customAlphabet(ALPHABET, SCHOOL_CODE_LENGTH);

/**
 * Generates a school code using only A-Z characters. Checks the schools
 * table for a pre-existing match and retries on collision. The DB-level
 * unique constraint on schoolsSchema.uniqueCode (see schools.ts) is the
 * real guarantee against duplicates — this pre-check just avoids letting
 * an avoidable constraint-violation bubble up to the caller in the
 * vanishingly rare case of a collision.
 */
async function generateUniqueSchoolCode(db: any): Promise<string> {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateRandomCode();

    const existing = await db
      .select({ id: schoolsSchema.id })
      .from(schoolsSchema)
      .where(eq(schoolsSchema.uniqueCode, candidate))
      .get();

    if (!existing) {
      return candidate;
    }
  }

  throw new Error(
    "Failed to generate a unique school code after multiple attempts"
  );
}

// ── List all invitations with school info ────────────────────────────────────

export async function getInvitations(db: any) {
  const invitations = await db
    .select({
      id: schoolInvitationsSchema.id,
      inviteToken: schoolInvitationsSchema.inviteToken,
      schoolName: schoolInvitationsSchema.schoolName,
      schoolEmail: schoolInvitationsSchema.schoolEmail,
      schoolPhone: schoolInvitationsSchema.schoolPhone,
      city: schoolInvitationsSchema.city,
      // Do NOT return notes — it contains the hashed password after registration
      // notes: schoolInvitationsSchema.notes,
      status: schoolInvitationsSchema.status,
      expiresAt: schoolInvitationsSchema.expiresAt,
      registeredAt: schoolInvitationsSchema.registeredAt,
      schoolId: schoolInvitationsSchema.schoolId,
      invitedBy: schoolInvitationsSchema.invitedBy,
      inviterName: superUsersSchema.name,
      createdAt: schoolInvitationsSchema.createdAt,
    })
    .from(schoolInvitationsSchema)
    .leftJoin(
      superUsersSchema,
      eq(schoolInvitationsSchema.invitedBy, superUsersSchema.id)
    )
    .orderBy(desc(schoolInvitationsSchema.createdAt))
    .all();

  return invitations;
}

// ── Get single invitation by token (public) ──────────────────────────────────

export async function getInvitationByToken(db: any, token: string) {
  return db
    .select()
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.inviteToken, token))
    .get();
}

// ── Create invitation ────────────────────────────────────────────────────────

export async function createInvitation(
  db: any,
  env: any,
  data: {
    schoolName: string;
    schoolEmail: string;
    schoolPhone?: string;
    city?: string;
    notes?: string;
    expiryDays?: number;
    invitedBy: number;
  }
) {
  // 1. Check if school email already has an ACTIVE school record
  //    (onboardingStatus = ACTIVE means they're already a customer)
  const existingActiveSchool = await db
    .select({
      id: schoolsSchema.id,
      onboardingStatus: schoolsSchema.onboardingStatus,
    })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.email, data.schoolEmail))
    .get();

  if (
    existingActiveSchool &&
    existingActiveSchool.onboardingStatus === "ACTIVE"
  ) {
    throw new Error(
      "A school with this email is already active on the platform"
    );
  }

  // 2. Check for an existing NON-expired, NON-cancelled invitation
  const existingInvite = await db
    .select({
      id: schoolInvitationsSchema.id,
      status: schoolInvitationsSchema.status,
    })
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.schoolEmail, data.schoolEmail))
    .get();

  if (
    existingInvite &&
    !["EXPIRED", "CANCELLED", "PAYMENT_APPROVED"].includes(
      existingInvite.status
    )
  ) {
    throw new Error(
      "An active invitation already exists for this email. Cancel it first or use Resend."
    );
  }

  // 3. Get fee config snapshot
  const feeConfig = await db
    .select({ setupFeeAmount: paymentConfigSchema.setupFeeFinalAmountPaise })
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  // 4. Generate invite token & expiry
  const inviteToken = crypto.randomUUID();
  const expiryDays = data.expiryDays ?? 30;
  const expiresAt = new Date(
    Date.now() + expiryDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // 5. Generate unique school code
  const uniqueCode = await generateUniqueSchoolCode(db);

  // 6. Transaction: create school record (INVITED state) + invitation
  //    If a previous non-active school record exists for this email, reuse it
  //    by updating instead of creating a new one (handles re-invite after cancel)
  const result = await db.transaction(async (tx: any) => {
    let schoolId: number;

    if (existingActiveSchool) {
      // Reuse the existing school record (previously invited but cancelled/expired)
      await tx
        .update(schoolsSchema)
        .set({
          name: data.schoolName,
          phone: data.schoolPhone || "",
          onboardingStatus: "INVITED",
          isActive: false,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(schoolsSchema.id, existingActiveSchool.id));
      schoolId = existingActiveSchool.id;
    } else {
      const [newSchool] = await tx
        .insert(schoolsSchema)
        .values({
          name: data.schoolName,
          uniqueCode,
          email: data.schoolEmail,
          phone: data.schoolPhone || "",
          onboardingStatus: "INVITED",
          isActive: false,
        })
        .returning();
      schoolId = newSchool.id;
    }

    const [newInvitation] = await tx
      .insert(schoolInvitationsSchema)
      .values({
        inviteToken,
        schoolName: data.schoolName,
        schoolEmail: data.schoolEmail,
        schoolPhone: data.schoolPhone || "",
        city: data.city || "",
        // Store internal notes (NOT the owner registration data — that's added during signup)
        notes: data.notes || "",
        status: "PENDING",
        invitedBy: data.invitedBy,
        expiresAt,
        schoolId,
      })
      .returning();

    // Fetch the school code (may have been reused from existing record)
    const school = await tx
      .select({ uniqueCode: schoolsSchema.uniqueCode })
      .from(schoolsSchema)
      .where(eq(schoolsSchema.id, schoolId))
      .get();

    return {
      invitation: newInvitation,
      schoolCode: school?.uniqueCode || uniqueCode,
    };
  });

  // 7. Send invite email — FIXED: use /school/register?token= (new URL)
  const frontendUrl = getFrontendUrl(env);
  const registrationLink = `${frontendUrl}/school/onboard?token=${inviteToken}`;
  const emailResult = await sendInviteEmail(env, {
    to: data.schoolEmail,
    schoolName: data.schoolName,
    registrationLink,
    setupFeeFinalAmountPaise: feeConfig?.setupFeeFinalAmountPaise ?? 0,
    expiryDays,
  });

  return {
    invitation: result.invitation,
    registrationLink,
    emailSent: emailResult.success,
  };
}

// ── Cancel invitation ────────────────────────────────────────────────────────

export async function cancelInvitation(db: any, id: number) {
  const inv = await db
    .select({
      id: schoolInvitationsSchema.id,
      status: schoolInvitationsSchema.status,
    })
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.id, id))
    .get();

  if (!inv) throw new Error("Invitation not found");
  if (["PAYMENT_APPROVED"].includes(inv.status)) {
    throw new Error("Cannot cancel an approved invitation");
  }

  await db
    .update(schoolInvitationsSchema)
    .set({ status: "CANCELLED", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schoolInvitationsSchema.id, id));
}

// ── Resend invite email ──────────────────────────────────────────────────────

export async function resendInvitation(db: any, env: any, id: number) {
  const inv = await db
    .select()
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.id, id))
    .get();

  if (!inv) throw new Error("Invitation not found");
  if (["CANCELLED"].includes(inv.status))
    throw new Error("Invitation is cancelled");

  const feeConfig = await db
    .select({ setupFeeAmount: paymentConfigSchema.setupFeeFinalAmountPaise })
    .from(paymentConfigSchema)
    .where(eq(paymentConfigSchema.id, 1))
    .get();

  const frontendUrl = getFrontendUrl(env);
  const registrationLink = `${frontendUrl}/school/onboard?token=${inv.inviteToken}`;

  const daysLeft = Math.ceil(
    (new Date(inv.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const emailResult = await sendInviteEmail(env, {
    to: inv.schoolEmail,
    schoolName: inv.schoolName,
    registrationLink,
    setupFeeFinalAmountPaise: feeConfig?.setupFeeFinalAmountPaise ?? 0,
    expiryDays: Math.max(daysLeft, 1), // at least 1 day shown
  });

  return {
    registrationLink,
    emailSent: emailResult.success,
  };
}

// ── Email helper ─────────────────────────────────────────────────────────────

async function sendInviteEmail(
  env: any,
  opts: {
    to: string;
    schoolName: string;
    registrationLink: string;
    setupFeeFinalAmountPaise: number;
    expiryDays: number;
  }
) {
  const feeFormatted =
    opts.setupFeeFinalAmountPaise > 0
      ? `₹${(opts.setupFeeFinalAmountPaise / 100).toLocaleString("en-IN")}`
      : "as informed by our team";

  const emailData: BrevoSendEmailRequest = {
    sender: {
      email: env.BREVO_SENDER_EMAIL,
      name: env.BREVO_SENDER_NAME,
    },
    to: [{ email: opts.to, name: opts.schoolName }],
    subject: `You're invited to join our School Management Platform`,
    htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f4f6f9; }
          .container { max-width: 600px; margin: 32px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
          .header { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 40px 32px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 28px; font-weight: 700; }
          .header p { color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 15px; }
          .body { padding: 32px; }
          .body p { color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
          .fee-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
          .fee-box .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
          .fee-box .amount { font-size: 32px; font-weight: 800; color: #065f46; }
          .cta { text-align: center; margin: 32px 0; }
          .cta a { display: inline-block; padding: 14px 36px; background: #4f46e5; color: white; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; }
          .note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; margin: 24px 0; font-size: 13px; color: #92400e; }
          .footer { padding: 24px 32px; border-top: 1px solid #f3f4f6; text-align: center; color: #9ca3af; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎓 Welcome to SMS!</h1>
            <p>Your school management journey starts here</p>
          </div>
          <div class="body">
            <p>Dear <strong>${opts.schoolName}</strong>,</p>
            <p>Our team has personally invited you to set up your school on our School Management System. We're excited to have you on board!</p>
            <p>To complete your registration, there is a one-time setup fee:</p>
            <div class="fee-box">
              <div class="label">One-time Setup Fee</div>
              <div class="amount">${feeFormatted}</div>
              <div style="margin-top: 8px; font-size: 13px; color: #065f46;">Includes onboarding support from our team</div>
            </div>
            <p>Click the button below to complete your registration and view payment instructions:</p>
            <div class="cta">
              <a href="${opts.registrationLink}">Complete Registration →</a>
            </div>
            <div class="note">
              ⏳ This invitation expires in <strong>${opts.expiryDays} days</strong>. If you have any questions, please contact our support team.
            </div>
            <p>If the button doesn't work, copy and paste this link on browser:<br>
            <a href="${opts.registrationLink}" style="color: #4f46e5; font-size: 13px;">${opts.registrationLink}</a></p>
          </div>
          <div class="footer">
            <p>Best regards, Eduxo Team</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  const result = await sendTransactionalEmail(env, emailData);
  if ("error" in result) {
    console.error("Invite email failed:", result.error);
    return { success: false, error: result.error };
  }
  return { success: true };
}
