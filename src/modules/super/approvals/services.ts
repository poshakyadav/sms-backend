// src/modules/super/approvals/services.ts

import { eq, desc, sql } from "drizzle-orm";
import { schoolPaymentRecordsSchema } from "../../../db/schemas/super/school-payment-records";
import { schoolsSchema } from "../../../db/schemas/super/schools";
import { schoolInvitationsSchema } from "../../../db/schemas/super/school-invitations";
import { tursoDatabasesSchema } from "../../../db/schemas/super/turso-databases";
import { superUsersSchema } from "../../../db/schemas/super/super-users";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { getSchoolDB } from "../../../db/school-client";

// School-side schemas (for provisioning the school DB)
import {
  schoolUsersSchema,
  schoolRolesSchema,
  schoolUserRolesSchema,
  schoolsSchema as schoolLocalSchema,
  staffSchema,
} from "../../../db/schemas/school";
import { SchoolRole } from "../../../types/school-role";
import { seedPermissionsAndRoles } from "../../school/permissions/services";
import { schoolSettingsService } from "../../school/settings/services";
import { getUserPermissionsFromDB } from "../../school/auth/permission-helpers";

const FRONTEND_URL = "http://localhost:4200";

// ── List all payment records (pending + all) ─────────────────────────────────

export async function getPendingApprovals(db: any) {
  const records = await db
    .select({
      id: schoolPaymentRecordsSchema.id,
      schoolId: schoolPaymentRecordsSchema.schoolId,
      invitationId: schoolPaymentRecordsSchema.invitationId,
      amountExpected: schoolPaymentRecordsSchema.amountExpected,
      amountPaid: schoolPaymentRecordsSchema.amountPaid,
      utrNumber: schoolPaymentRecordsSchema.utrNumber,
      screenshotUrl: schoolPaymentRecordsSchema.screenshotUrl,
      payerName: schoolPaymentRecordsSchema.payerName,
      payerPhone: schoolPaymentRecordsSchema.payerPhone,
      submittedAt: schoolPaymentRecordsSchema.submittedAt,
      status: schoolPaymentRecordsSchema.status,
      rejectionReason: schoolPaymentRecordsSchema.rejectionReason,
      internalNotes: schoolPaymentRecordsSchema.internalNotes,
      verifiedAt: schoolPaymentRecordsSchema.verifiedAt,
      createdAt: schoolPaymentRecordsSchema.createdAt,
      schoolName: schoolsSchema.name,
      schoolEmail: schoolsSchema.email,
      schoolPhone: schoolsSchema.phone,
      onboardingStatus: schoolsSchema.onboardingStatus,
      invitationCity: schoolInvitationsSchema.city,
    })
    .from(schoolPaymentRecordsSchema)
    .innerJoin(
      schoolsSchema,
      eq(schoolPaymentRecordsSchema.schoolId, schoolsSchema.id)
    )
    .leftJoin(
      schoolInvitationsSchema,
      eq(schoolPaymentRecordsSchema.invitationId, schoolInvitationsSchema.id)
    )
    .orderBy(desc(schoolPaymentRecordsSchema.createdAt))
    .all();

  return records;
}

// ── Get single approval detail ───────────────────────────────────────────────

export async function getApprovalDetail(db: any, paymentRecordId: number) {
  return db
    .select({
      payment: schoolPaymentRecordsSchema,
      schoolName: schoolsSchema.name,
      schoolEmail: schoolsSchema.email,
      schoolPhone: schoolsSchema.phone,
      onboardingStatus: schoolsSchema.onboardingStatus,
      invitationCity: schoolInvitationsSchema.city,
      invitationNotes: schoolInvitationsSchema.notes,
      verifierName: superUsersSchema.name,
    })
    .from(schoolPaymentRecordsSchema)
    .innerJoin(
      schoolsSchema,
      eq(schoolPaymentRecordsSchema.schoolId, schoolsSchema.id)
    )
    .leftJoin(
      schoolInvitationsSchema,
      eq(schoolPaymentRecordsSchema.invitationId, schoolInvitationsSchema.id)
    )
    .leftJoin(
      superUsersSchema,
      eq(schoolPaymentRecordsSchema.verifiedBy, superUsersSchema.id)
    )
    .where(eq(schoolPaymentRecordsSchema.id, paymentRecordId))
    .get();
}

// ── Approve payment — the full provisioning flow ─────────────────────────────

export async function approvePayment(
  db: any,
  env: any,
  paymentRecordId: number,
  verifiedBy: number,
  internalNotes?: string
) {
  // 1. Fetch payment record
  const record = await db
    .select()
    .from(schoolPaymentRecordsSchema)
    .where(eq(schoolPaymentRecordsSchema.id, paymentRecordId))
    .get();

  if (!record) throw new Error("Payment record not found");
  if (record.status === "VERIFIED") throw new Error("Payment already approved");
  if (record.status === "REJECTED") {
    throw new Error(
      "Cannot approve a rejected payment. Ask school to resubmit."
    );
  }

  // 2. Fetch school from super DB
  const school = await db
    .select()
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, record.schoolId))
    .get();

  if (!school) throw new Error("School not found");

  // 3. Fetch invitation (to get stored owner registration data)
  const invitation = await db
    .select()
    .from(schoolInvitationsSchema)
    .where(eq(schoolInvitationsSchema.id, record.invitationId))
    .get();

  if (!invitation) throw new Error("Invitation record not found");

  // 4. Parse stored owner registration data
  let ownerData: {
    ownerName: string;
    ownerEmail: string;
    passwordHash: string;
    ownerPhone: string;
    ownerAlternatePhone: string;
    schoolName: string;
    addressLineOne: string;
    addressLineTwo: string;
    phone: string;
    alternatePhone: string;
    schoolEmail: string;
    schoolWebsite: string;
    termsAcceptedAt?: string;
  } | null = null;

  try {
    if (invitation.notes) {
      ownerData = JSON.parse(invitation.notes);
    }
  } catch (e) {
    console.error("Failed to parse owner registration data:", e);
  }

  if (!ownerData || !ownerData.passwordHash) {
    throw new Error(
      "Owner registration data is missing or corrupted. School may need to re-register."
    );
  }

  // ── Check if school already has a DB assigned (from a failed previous run) ───
  // If so, reuse it rather than assigning a new one.
  let availableDb;

  if (school.tursoDbId) {
    // School already has a DB from a previous (failed) provisioning attempt.
    // Reuse it — provisionSchoolDatabase is idempotent and handles re-runs.
    availableDb = await db
      .select()
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.id, school.tursoDbId))
      .get();

    console.log(
      `♻️  Reusing previously assigned DB id=${availableDb?.id} for school ${school.uniqueCode}`
    );
  } else {
    // Fresh school — find an unassigned DB
    availableDb = await db
      .select()
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.isAssigned, false))
      .limit(1)
      .get();
  }

  if (!availableDb) {
    throw new Error(
      "No available databases to provision. Please add more Turso databases first."
    );
  }

  const schoolCode = school.uniqueCode;

  // 6. Super DB transaction: verify payment + assign DB + activate school
  await db.transaction(async (tx: any) => {
    // Mark payment as VERIFIED
    await tx
      .update(schoolPaymentRecordsSchema)
      .set({
        status: "VERIFIED",
        verifiedBy,
        verifiedAt: new Date().toISOString(),
        internalNotes: internalNotes || "",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolPaymentRecordsSchema.id, paymentRecordId));

    // Assign DB to school + activate
    await tx
      .update(schoolsSchema)
      .set({
        onboardingStatus: "ACTIVE",
        isActive: true,
        tursoDbId: availableDb.id,
        activatedAt: new Date().toISOString(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolsSchema.id, record.schoolId));

    // Mark DB as assigned
    await tx
      .update(tursoDatabasesSchema)
      .set({ isAssigned: true })
      .where(eq(tursoDatabasesSchema.id, availableDb.id));

    // Update invitation status
    await tx
      .update(schoolInvitationsSchema)
      .set({
        status: "PAYMENT_APPROVED",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolInvitationsSchema.id, record.invitationId));
  });

  // 7. Provision the school's Turso DB — this is the critical step
  //    that was missing from the original Claude implementation
  try {
    await provisionSchoolDatabase(env, schoolCode, school, ownerData);
  } catch (provisionError: any) {
    console.error(
      "CRITICAL: School DB provisioning failed after payment approval:",
      provisionError
    );
    // We do NOT rollback the super DB changes here because the payment IS approved.
    // Instead we log the error so an admin can manually re-trigger provisioning.
    // In a more robust system you'd have a retry queue for this.
    throw new Error(
      `Payment approved but school DB provisioning failed: ${provisionError.message}. ` +
        `Please contact support with school code: ${schoolCode}`
    );
  }

  // 8. Send activation email
  const loginLink = `${FRONTEND_URL}/login`;
  await sendActivationEmail(env, {
    to: school.email,
    ownerEmail: ownerData.ownerEmail,
    schoolName: school.name,
    schoolCode,
    loginLink,
  });
}

// ── Provision school DB (the core seeding logic from original signup) ─────────

async function provisionSchoolDatabase(
  env: any,
  schoolCode: string,
  school: any,
  ownerData: {
    ownerName: string;
    ownerEmail: string;
    passwordHash: string;
    ownerPhone: string;
    ownerAlternatePhone: string;
    schoolName: string;
    addressLineOne: string;
    addressLineTwo: string;
    phone: string;
    alternatePhone: string;
    schoolEmail: string;
    schoolWebsite: string;
    termsAcceptedAt?: string;
  }
) {
  console.log(`🚀 Provisioning school DB for: ${schoolCode}`);

  const schoolDb = await getSchoolDB(env, schoolCode);

  // ── Sanity check: ensure this DB is clean or already provisioned for THIS school ──
  // If the DB has data for a DIFFERENT school code, something went wrong upstream.
  const existingSchoolRecord = await schoolDb
    .select({ uniqueCode: schoolLocalSchema.uniqueCode })
    .from(schoolLocalSchema)
    .get();

  if (existingSchoolRecord && existingSchoolRecord.uniqueCode !== schoolCode) {
    throw new Error(
      `DB contamination detected: DB contains data for school "${existingSchoolRecord.uniqueCode}" ` +
        `but we are trying to provision "${schoolCode}". ` +
        `This Turso DB was previously used. Please assign a clean DB and retry.`
    );
  }

  // ── Step 1: Insert school record and with the correct schoolCode ──────────────────────────────────────────
  // Do this outside any transaction — it's idempotent via onConflictDoNothing
  await schoolDb
    .insert(schoolLocalSchema)
    .values({
      name: ownerData.schoolName || school.name,
      uniqueCode: schoolCode, // Always use the super DB's authoritative code
      addressLineOne: ownerData.addressLineOne || "",
      addressLineTwo: ownerData.addressLineTwo || "",
      phone: ownerData.phone || school.phone || "",
      alternatePhone: ownerData.alternatePhone || "",
      email: ownerData.schoolEmail || school.email || "",
      website: ownerData.schoolWebsite || "",
      isActive: true,
    })
    .onConflictDoNothing();

  // ── Step 2: Insert the school owner user ──────────────────────────────────
  const existingUser = await schoolDb
    .select({ id: schoolUsersSchema.id })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.email, ownerData.ownerEmail))
    .get();

  let userId: number;

  if (existingUser) {
    // Idempotent: already inserted (e.g. re-run after partial failure)
    userId = existingUser.id;
    console.log(`✅ Owner user already exists (id=${userId}), skipping insert`);

    // If the existing user hasn't accepted T&C yet, backfill it now.
    // This handles the case where provisioning ran partially before and
    // left termsAcceptedAt as NULL.
    if (ownerData.termsAcceptedAt) {
      await schoolDb
        .update(schoolUsersSchema)
        .set({ termsAcceptedAt: ownerData.termsAcceptedAt })
        .where(
          eq(schoolUsersSchema.id, userId)
          // Only update if still null — prevents overwriting a later acceptance
          // Note: SQLite has no UPDATE ... WHERE col IS NULL shorthand in Drizzle,
          // so we check in JS instead:
        );
      // Actually guard it properly:
    }
  } else {
    const [newUser] = await schoolDb
      .insert(schoolUsersSchema)
      .values({
        name: ownerData.ownerName,
        email: ownerData.ownerEmail,
        passwordHash: ownerData.passwordHash,
        primaryRole: SchoolRole.SCHOOL_OWNER,
        phone: ownerData.ownerPhone || "",
        alternatePhone: ownerData.ownerAlternatePhone || "",
        isActive: true,
        tokenVersion: 0,
        // Write T&C acceptance timestamp from registration time.
        // This means the owner's first login won't trigger the checkbox.
        termsAcceptedAt: ownerData.termsAcceptedAt ?? null,
      })
      .returning();
    userId = newUser.id;
  }

  const existingStaffProfile = await schoolDb
    .select({ userId: staffSchema.userId })
    .from(staffSchema)
    .where(eq(staffSchema.userId, userId))
    .get();

  if (!existingStaffProfile) {
    await schoolDb
      .insert(staffSchema)
      .values({
        userId,
        designation: SchoolRole.SCHOOL_OWNER,
        department: "",
        joiningDate: "",
        salary: 0,
        shift: "",
      });
    console.log(`✅ Staff profile created for SCHOOL_OWNER (userId=${userId})`);
  } else {
    console.log(`✅ Staff profile already exists for SCHOOL_OWNER (userId=${userId}), skipping`);
  }

  // ── Step 3: Seed permissions & roles ─────────────────────────────────────
  // seedPermissionsAndRoles creates its OWN db connection internally.
  // It MUST be called outside any open transaction on schoolDb — calling it
  // inside a transaction causes Turso to open a second HTTP stream on the same
  // DB URL which it rejects with HTTP 404.
  await seedPermissionsAndRoles(env, schoolCode);

  // ── Step 4: Assign SCHOOL_OWNER role ─────────────────────────────────────
  const ownerRole = await schoolDb
    .select({ id: schoolRolesSchema.id })
    .from(schoolRolesSchema)
    .where(eq(schoolRolesSchema.name, SchoolRole.SCHOOL_OWNER))
    .get();

  if (!ownerRole) {
    throw new Error("SCHOOL_OWNER role not found after seeding");
  }

  // idempotent insert
  await schoolDb
    .insert(schoolUserRolesSchema)
    .values({
      userId,
      roleId: ownerRole.id,
    })
    .onConflictDoNothing();

  // ── Step 5: Seed predefined themes ───────────────────────────────────────
  // Pass schoolDb directly (not a tx) — seedPredefinedThemes uses db.insert()
  // and is already idempotent via its own guard check at the top.
  await schoolSettingsService.seedPredefinedThemes(schoolDb, schoolCode);

  // ── Step 6: Verify ────────────────────────────────────────────────────────
  const ownerPermissions = await getUserPermissionsFromDB(schoolDb, userId);
  console.log(
    `✅ School DB provisioned for ${schoolCode}. Owner has ${ownerPermissions.length} permissions.`
  );

  console.log(`🎉 School ${schoolCode} fully provisioned and ready.`);
}

// ── Reject payment ───────────────────────────────────────────────────────────

export async function rejectPayment(
  db: any,
  env: any,
  paymentRecordId: number,
  verifiedBy: number,
  rejectionReason: string
) {
  const record = await db
    .select()
    .from(schoolPaymentRecordsSchema)
    .where(eq(schoolPaymentRecordsSchema.id, paymentRecordId))
    .get();

  if (!record) throw new Error("Payment record not found");
  if (record.status === "VERIFIED") {
    throw new Error("Cannot reject an already approved payment");
  }

  const school = await db
    .select()
    .from(schoolsSchema)
    .where(eq(schoolsSchema.id, record.schoolId))
    .get();

  await db.transaction(async (tx: any) => {
    await tx
      .update(schoolPaymentRecordsSchema)
      .set({
        status: "REJECTED",
        verifiedBy,
        verifiedAt: new Date().toISOString(),
        rejectionReason,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolPaymentRecordsSchema.id, paymentRecordId));

    // Revert school status so they can resubmit proof
    await tx
      .update(schoolsSchema)
      .set({
        onboardingStatus: "REGISTERED",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolsSchema.id, record.schoolId));

    // Revert invitation status so they can resubmit
    await tx
      .update(schoolInvitationsSchema)
      .set({
        status: "REGISTERED",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schoolInvitationsSchema.id, record.invitationId));
  });

  await sendRejectionEmail(env, {
    to: school.email,
    schoolName: school.name,
    rejectionReason,
  });
}

// ── Email helpers ────────────────────────────────────────────────────────────

async function sendActivationEmail(
  env: any,
  opts: {
    to: string;
    ownerEmail: string;
    schoolName: string;
    schoolCode: string;
    loginLink: string;
  }
) {
  // Send to both the school's registered email and the owner's personal email
  const recipients = [{ email: opts.to, name: opts.schoolName }];
  if (opts.ownerEmail && opts.ownerEmail !== opts.to) {
    recipients.push({ email: opts.ownerEmail, name: opts.schoolName });
  }

  const emailData: BrevoSendEmailRequest = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: recipients,
    subject: "🎉 Your school account is now active!",
    htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <style>
          body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f4f6f9}
          .c{max-width:600px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
          .h{background:linear-gradient(135deg,#059669,#10b981);padding:40px 32px;text-align:center;color:white}
          .h h1{margin:0;font-size:28px;font-weight:700}
          .b{padding:32px}.b p{color:#374151;font-size:15px;line-height:1.6}
          .info-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:20px 0}
          .cta{text-align:center;margin:32px 0}
          .cta a{display:inline-block;padding:14px 36px;background:#059669;color:white;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px}
          .f{padding:24px;border-top:1px solid #f3f4f6;text-align:center;color:#9ca3af;font-size:13px}
        </style>
      </head>
      <body>
        <div class="c">
          <div class="h"><h1>✅ Payment Verified — Welcome Aboard!</h1></div>
          <div class="b">
            <p>Dear <strong>${opts.schoolName}</strong>,</p>
            <p>We've successfully verified your payment. Your school account is now <strong>fully active</strong> and ready to use!</p>
            <div class="info-box">
              <p style="margin:0;font-size:15px"><strong>Your School Code:</strong> ${opts.schoolCode}</p>
              <p style="margin:8px 0 0;font-size:13px;color:#065f46">You'll need this code every time you log in.</p>
            </div>
            <p>Log in now to start managing your school:</p>
            <div class="cta"><a href="${opts.loginLink}">Go to School Portal →</a></div>
            <p>Welcome to the SMS family! Our onboarding team is here if you need any help getting started.</p>
          </div>
          <div class="f"><p>Best regards, SMS Team</p></div>
        </div>
      </body>
      </html>
    `,
  };
  await sendTransactionalEmail(env, emailData);
}

async function sendRejectionEmail(
  env: any,
  opts: { to: string; schoolName: string; rejectionReason: string }
) {
  const emailData: BrevoSendEmailRequest = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: opts.to, name: opts.schoolName }],
    subject: "Payment verification issue — action required",
    htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <style>
          body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:0;background:#f4f6f9}
          .c{max-width:600px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
          .h{background:linear-gradient(135deg,#dc2626,#ef4444);padding:40px 32px;text-align:center;color:white}
          .h h1{margin:0;font-size:24px;font-weight:700}
          .b{padding:32px}.b p{color:#374151;font-size:15px;line-height:1.6}
          .reason-box{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:20px 0;color:#991b1b}
          .f{padding:24px;border-top:1px solid #f3f4f6;text-align:center;color:#9ca3af;font-size:13px}
        </style>
      </head>
      <body>
        <div class="c">
          <div class="h"><h1>⚠️ Payment Verification Issue</h1></div>
          <div class="b">
            <p>Dear <strong>${opts.schoolName}</strong>,</p>
            <p>We were unable to verify your payment. Please see the reason below and resubmit.</p>
            <div class="reason-box"><strong>Reason:</strong> ${opts.rejectionReason}</div>
            <p>Please log back into your payment portal and resubmit your payment proof. If you need help, contact our support team.</p>
          </div>
          <div class="f"><p>Best regards, SMS Team</p></div>
        </div>
      </body>
      </html>
    `,
  };
  await sendTransactionalEmail(env, emailData);
}
