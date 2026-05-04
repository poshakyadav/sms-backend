// src/modules/super/public/school-registration-requests/services.ts

import { eq, and, inArray } from "drizzle-orm";
import { RegistrationRequestStatus, schoolRegistrationRequestsSchema } from "../../../db";
import { BrevoSendEmailRequest } from "../../../types/brevo";
import { sendTransactionalEmail } from "../../../utils/sendEmail";


interface SubmitRequestData {
  schoolName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  city: string;
  state: string;
  schoolType: "PRIMARY" | "SECONDARY" | "HIGHER_SECONDARY" | "OTHER";
  estimatedStudents?: number;
  message?: string;
}

// ── Submit ────────────────────────────────────────────────────────────────────

export async function submitRegistrationRequest(
  db: any,
  data: SubmitRequestData,
  env: any
) {
  // Check for duplicate — same email + active status
  const existing = await db
    .select({
      id: schoolRegistrationRequestsSchema.id,
      status: schoolRegistrationRequestsSchema.status,
    })
    .from(schoolRegistrationRequestsSchema)
    .where(
      and(
        eq(
          schoolRegistrationRequestsSchema.ownerEmail,
          data.ownerEmail.toLowerCase().trim()
        ),
        inArray(schoolRegistrationRequestsSchema.status, [
          RegistrationRequestStatus.PENDING,
          RegistrationRequestStatus.REVIEWED,
        ])
      )
    )
    .get();

  if (existing) {
    throw new Error("DUPLICATE_REQUEST");
  }

  // Insert
  const [newRequest] = await db
    .insert(schoolRegistrationRequestsSchema)
    .values({
      schoolName: data.schoolName.trim(),
      ownerName: data.ownerName.trim(),
      ownerEmail: data.ownerEmail.toLowerCase().trim(),
      ownerPhone: data.ownerPhone.trim(),
      city: data.city.trim(),
      state: data.state.trim(),
      schoolType: data.schoolType,
      estimatedStudents: data.estimatedStudents ?? null,
      message: data.message?.trim() ?? "",
      status: RegistrationRequestStatus.PENDING,
    })
    .returning();

  // Email to super admin
  const adminEmail: BrevoSendEmailRequest = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: env.BREVO_SENDER_EMAIL, name: "SMS Admin" }],
    subject: `🏫 New School Registration Request — ${data.schoolName}`,
    htmlContent: `
      <!DOCTYPE html><html><head>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
        .c{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        .h{background:linear-gradient(135deg,#3b82f6,#1e40af);padding:36px 32px;color:#fff}
        .h h1{margin:0;font-size:22px;font-weight:700}
        .b{padding:32px}
        .row{display:flex;gap:8px;margin-bottom:12px}
        .label{font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;min-width:140px}
        .val{font-size:15px;color:#0f172a;font-weight:500}
        .msg-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:20px 0;font-size:14px;color:#374151;line-height:1.6}
        .cta{text-align:center;margin:28px 0}
        .cta a{display:inline-block;padding:13px 32px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-weight:700}
        .f{padding:20px 32px;border-top:1px solid #f1f5f9;text-align:center;color:#94a3b8;font-size:13px}
      </style></head><body>
      <div class="c">
        <div class="h"><h1>📋 New School Registration Request</h1></div>
        <div class="b">
          <div class="row"><span class="label">School Name</span><span class="val">${
            data.schoolName
          }</span></div>
          <div class="row"><span class="label">School Type</span><span class="val">${
            data.schoolType
          }</span></div>
          <div class="row"><span class="label">City / State</span><span class="val">${
            data.city
          }, ${data.state}</span></div>
          <div class="row"><span class="label">Est. Students</span><span class="val">${
            data.estimatedStudents ?? "Not specified"
          }</span></div>
          <div class="row"><span class="label">Owner Name</span><span class="val">${
            data.ownerName
          }</span></div>
          <div class="row"><span class="label">Owner Email</span><span class="val">${
            data.ownerEmail
          }</span></div>
          <div class="row"><span class="label">Owner Phone</span><span class="val">${
            data.ownerPhone
          }</span></div>
          ${
            data.message
              ? `<div class="msg-box"><strong>Message from school:</strong><br>${data.message}</div>`
              : ""
          }
          <div class="cta"><a href="${
            env.SUPER_FRONTEND_URL ?? "http://localhost:4200"
          }/super/school-requests">Review Request →</a></div>
        </div>
        <div class="f">SMS Admin Portal</div>
      </div></body></html>
    `,
  };

  sendTransactionalEmail(env, adminEmail).catch(console.error);

  // Acknowledgment to school owner
  const ackEmail: BrevoSendEmailRequest = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: data.ownerEmail, name: data.ownerName }],
    subject: `We received your registration request — ${data.schoolName}`,
    htmlContent: `
      <!DOCTYPE html><html><head>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
        .c{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        .h{background:linear-gradient(135deg,#3b82f6,#1e40af);padding:36px 32px;text-align:center;color:#fff}
        .h .icon{font-size:48px;margin-bottom:12px}
        .h h1{margin:0;font-size:24px;font-weight:700}
        .b{padding:32px}
        .b p{color:#374151;font-size:15px;line-height:1.7}
        .steps{background:#f0f9ff;border-radius:10px;padding:20px 24px;margin:20px 0}
        .step{display:flex;gap:14px;margin-bottom:14px;align-items:flex-start}
        .step-num{background:#3b82f6;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
        .step-text{font-size:14px;color:#374151;line-height:1.5}
        .f{padding:20px 32px;border-top:1px solid #f1f5f9;text-align:center;color:#94a3b8;font-size:13px}
      </style></head><body>
      <div class="c">
        <div class="h">
          <div class="icon">✅</div>
          <h1>Request Received!</h1>
        </div>
        <div class="b">
          <p>Hi <strong>${data.ownerName}</strong>,</p>
          <p>Thank you for your interest in joining our School Management System! We've received your registration request for <strong>${data.schoolName}</strong>.</p>
          <div class="steps">
            <div class="step"><div class="step-num">1</div><div class="step-text"><strong>Request Received</strong> — We have your details and will review them shortly.</div></div>
            <div class="step"><div class="step-num">2</div><div class="step-text"><strong>We'll Contact You</strong> — Our team will reach out within 24–48 hours.</div></div>
            <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Go Live</strong> — After a quick onboarding call, your school will be set up and ready.</div></div>
          </div>
          <p>If you have any questions in the meantime, feel free to reply to this email.</p>
          <p>We look forward to connecting with you!</p>
          <p>Warm regards,<br><strong>SMS Team</strong></p>
        </div>
        <div class="f">You received this because you submitted a registration request. If this wasn't you, please ignore this email.</div>
      </div></body></html>
    `,
  };

  sendTransactionalEmail(env, ackEmail).catch(console.error);

  return newRequest;
}

// ── Status check ──────────────────────────────────────────────────────────────

export async function getRegistrationRequestStatus(db: any, email: string) {
  return db
    .select({
      status: schoolRegistrationRequestsSchema.status,
      createdAt: schoolRegistrationRequestsSchema.createdAt,
    })
    .from(schoolRegistrationRequestsSchema)
    .where(eq(schoolRegistrationRequestsSchema.ownerEmail, email))
    .orderBy(schoolRegistrationRequestsSchema.createdAt)
    .get();
}
