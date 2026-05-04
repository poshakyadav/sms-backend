// src/modules/school/contact/services.ts

import { desc, eq } from "drizzle-orm";
import {
  schoolContactMessagesSchema,
  ContactMessageStatus,
} from "../../../db/schemas/super/school-contact-messages";
import { schoolsSchema } from "../../../db/schemas/super/schools";
import { sendTransactionalEmail } from "../../../utils/sendEmail";
import { BrevoSendEmailRequest } from "../../../types/brevo";

interface SubmitMessageData {
  category:
    | "TECHNICAL_ISSUE"
    | "BILLING"
    | "FEATURE_REQUEST"
    | "ACCOUNT_ISSUE"
    | "OTHER";
  subject: string;
  message: string;
  ownerUserId: number;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  schoolCode: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  TECHNICAL_ISSUE: "Technical Issue",
  BILLING: "Billing",
  FEATURE_REQUEST: "Feature Request",
  ACCOUNT_ISSUE: "Account Issue",
  OTHER: "Other",
};

// ── Submit ────────────────────────────────────────────────────────────────────

export async function submitContactMessage(
  commonDb: any,
  data: SubmitMessageData,
  env: any
) {
  // Fetch school from super DB
  const school = await commonDb
    .select({ id: schoolsSchema.id, name: schoolsSchema.name })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.uniqueCode, data.schoolCode))
    .get();

  if (!school) throw new Error("School not found");

  const [newMessage] = await commonDb
    .insert(schoolContactMessagesSchema)
    .values({
      schoolId: school.id,
      schoolCode: data.schoolCode,
      schoolName: school.name,
      ownerUserId: data.ownerUserId,
      ownerName: data.ownerName,
      ownerEmail: data.ownerEmail,
      ownerPhone: data.ownerPhone,
      category: data.category,
      subject: data.subject,
      message: data.message,
      status: ContactMessageStatus.OPEN,
    })
    .returning();

  const referenceId = `MSG-${String(newMessage.id).padStart(6, "0")}`;
  const categoryLabel = CATEGORY_LABELS[data.category] ?? data.category;

  // Admin notification
  const adminEmail: BrevoSendEmailRequest = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: env.BREVO_SENDER_EMAIL, name: "SMS Admin" }],
    subject: `💬 New Contact Message — ${school.name} [${categoryLabel}]`,
    htmlContent: `
      <!DOCTYPE html><html><head>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
        .c{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        .h{background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:32px;color:#fff}
        .h h1{margin:0;font-size:20px;font-weight:700}
        .h .ref{margin-top:8px;font-size:13px;opacity:.8}
        .b{padding:32px}
        .row{display:flex;gap:8px;margin-bottom:12px}
        .label{font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;min-width:120px}
        .val{font-size:15px;color:#0f172a;font-weight:500}
        .msg-box{background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:16px;margin:20px 0;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap}
        .cta{text-align:center;margin:24px 0}
        .cta a{display:inline-block;padding:13px 32px;background:#8b5cf6;color:#fff;text-decoration:none;border-radius:8px;font-weight:700}
        .f{padding:20px 32px;border-top:1px solid #f1f5f9;text-align:center;color:#94a3b8;font-size:13px}
      </style></head><body>
      <div class="c">
        <div class="h">
          <h1>📩 New Contact Message</h1>
          <div class="ref">Reference: ${referenceId}</div>
        </div>
        <div class="b">
          <div class="row"><span class="label">School</span><span class="val">${
            school.name
          } (${data.schoolCode})</span></div>
          <div class="row"><span class="label">Category</span><span class="val">${categoryLabel}</span></div>
          <div class="row"><span class="label">Subject</span><span class="val">${
            data.subject
          }</span></div>
          <div class="row"><span class="label">From</span><span class="val">${
            data.ownerName
          }</span></div>
          <div class="row"><span class="label">Email</span><span class="val">${
            data.ownerEmail
          }</span></div>
          <div class="row"><span class="label">Phone</span><span class="val">${
            data.ownerPhone || "—"
          }</span></div>
          <div class="msg-box">${data.message}</div>
          <div class="cta"><a href="${
            env.SUPER_FRONTEND_URL ?? "http://localhost:4200"
          }/super/contact-messages">View in Admin Portal →</a></div>
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
    subject: `Message received — ${referenceId}`,
    htmlContent: `
      <!DOCTYPE html><html><head>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
        .c{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
        .h{background:linear-gradient(135deg,#8b5cf6,#6d28d9);padding:32px;text-align:center;color:#fff}
        .h h1{margin:0;font-size:22px;font-weight:700}
        .b{padding:32px}.b p{color:#374151;font-size:15px;line-height:1.7}
        .ref-box{background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:16px;text-align:center;margin:20px 0}
        .ref-label{font-size:12px;color:#7c3aed;font-weight:600;text-transform:uppercase;letter-spacing:1px}
        .ref-id{font-size:24px;font-weight:700;color:#6d28d9;margin-top:6px}
        .f{padding:20px 32px;border-top:1px solid #f1f5f9;text-align:center;color:#94a3b8;font-size:13px}
      </style></head><body>
      <div class="c">
        <div class="h"><h1>Message Received ✅</h1></div>
        <div class="b">
          <p>Hi <strong>${data.ownerName}</strong>,</p>
          <p>We've received your message and our team will review it shortly.</p>
          <div class="ref-box">
            <div class="ref-label">Your Reference ID</div>
            <div class="ref-id">${referenceId}</div>
          </div>
          <p><strong>Subject:</strong> ${data.subject}</p>
          <p>We typically respond within <strong>1–2 business days</strong>. If your issue is urgent, please mention that and we'll prioritize accordingly.</p>
          <p>Best regards,<br><strong>SMS Support Team</strong></p>
        </div>
        <div class="f">If you did not send this message, please contact us immediately.</div>
      </div></body></html>
    `,
  };

  sendTransactionalEmail(env, ackEmail).catch(console.error);

  return newMessage;
}

// ── History ───────────────────────────────────────────────────────────────────

export async function getSchoolContactHistory(
  commonDb: any,
  schoolCode: string
) {
  return commonDb
    .select({
      id: schoolContactMessagesSchema.id,
      category: schoolContactMessagesSchema.category,
      subject: schoolContactMessagesSchema.subject,
      status: schoolContactMessagesSchema.status,
      createdAt: schoolContactMessagesSchema.createdAt,
    })
    .from(schoolContactMessagesSchema)
    .where(eq(schoolContactMessagesSchema.schoolCode, schoolCode))
    .orderBy(desc(schoolContactMessagesSchema.createdAt))
    .all();
}
