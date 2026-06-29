// src/modules/school/whatsapp/send-service.ts
//
// Core service layer for all outbound WhatsApp messaging.
// Handles: credit check → deduct → call Meta → log result.
//
// Both single sends (attendance, fees, exams, assignments triggers) and
// bulk sends delegate to sendOneMessage() for the per-message logic.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  getCommonDB,
  schoolsSchema as superSchoolsSchema,
  whatsappWamidIndexSchema,
} from "../../../db";

import {
  schoolStudentEnrollmentsSchema,
  schoolUsersSchema,
  studentParentsSchema,
  whatsappBalanceSchema,
  whatsappBulkSendsSchema,
  whatsappMessagesSchema,
  whatsappTemplatesSchema,
} from "../../../db/schemas/school";
import { getSchoolDB } from "../../../db/school-client";
import {
  getWhatsappService,
  WhatsappApiError,
} from "../../../services/whatsapp/whatsapp-service";
import {
  buildBodyParameters,
  deductWhatsappCredits,
  getWhatsappBalance,
  isValidPhone,
  normalisePhone,
} from "../../../utils/whatsapp-credits";

import { SchoolEnv } from "../../../types/common-types";
import {
  BulkSendInitiateInput,
  BulkSendResult,
  BulkSendStatus,
  PLATFORM_TEMPLATES,
  PlatformTemplateKey,
  SendMessageResult,
  SendSingleMessageInput,
  WhatsappMessageStatus,
  WhatsappTemplateStatus,
} from "../../../types/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE SYNC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pulls the latest template statuses from Meta WABA and upserts them
 * into this school's whatsapp_templates table.
 *
 * Called by POST /school/whatsapp/templates/sync.
 * Also useful to run once after deploying to seed the local template cache.
 */
export async function syncTemplates(
  env: SchoolEnv["Bindings"],
  schoolCode: string
): Promise<{ synced: number; approved: number }> {
  const wa = getWhatsappService(env as any);
  const schoolDb = await getSchoolDB(env, schoolCode);
  const rawTemplates = await wa.getTemplates();

  // Cache only our platform templates (all start with "school_" or "sms_")
  const ours = rawTemplates.filter(
    (t: any) => t.name.startsWith("school_") || t.name.startsWith("sms_")
  );
  let synced = 0;
  let approved = 0;

  for (const t of ours) {
    const bodyComp = t.components?.find((c: any) => c.type === "BODY");
    const bodyPreview = bodyComp?.text ?? "";

    const localDef = (Object.values(PLATFORM_TEMPLATES) as any[]).find(
      (d) => d.name === t.name
    );
    const variableNames = localDef
      ? JSON.stringify([...localDef.variables])
      : "[]";

    const existing = await schoolDb
      .select({ id: whatsappTemplatesSchema.id })
      .from(whatsappTemplatesSchema)
      .where(eq(whatsappTemplatesSchema.name, t.name))
      .get();

    if (existing) {
      await schoolDb
        .update(whatsappTemplatesSchema)
        .set({
          status: t.status,
          category: t.category as any,
          bodyPreview,
          variableNames,
          lastSyncedAt: new Date().toISOString(),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(whatsappTemplatesSchema.name, t.name));
    } else {
      await schoolDb.insert(whatsappTemplatesSchema).values({
        name: t.name,
        language: t.language ?? "en",
        category: t.category as any,
        status: t.status,
        bodyPreview,
        variableNames,
        lastSyncedAt: new Date().toISOString(),
      });
    }

    synced++;
    if (t.status === "APPROVED") approved++;
  }

  return { synced, approved };
}

/**
 * Lists templates from local DB cache (fast, no Meta API call).
 * Optionally filters to only APPROVED templates.
 */
export async function listTemplates(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  onlyApproved = false
) {
  const schoolDb = await getSchoolDB(env, schoolCode);
  if (onlyApproved) {
    return schoolDb
      .select()
      .from(whatsappTemplatesSchema)
      .where(
        eq(whatsappTemplatesSchema.status, WhatsappTemplateStatus.APPROVED)
      )
      .all();
  }
  return schoolDb.select().from(whatsappTemplatesSchema).all();
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE MESSAGE SEND (core function used by everything else)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a single WhatsApp template message to one recipient.
 *
 * CHANGE: On successful send, inserts a row into the super DB
 * whatsapp_wamid_index so the status webhook can resolve the school in O(1)
 * instead of scanning all active schools.
 */
export async function sendOneMessage(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  input: SendSingleMessageInput,
  bulkSendId?: number
): Promise<SendMessageResult> {
  const schoolDb = await getSchoolDB(env, schoolCode);

  // 1. Normalise and validate phone
  const normalisedPhone = normalisePhone(input.recipientPhone);
  if (!isValidPhone(normalisedPhone)) {
    return {
      success: false,
      error: `Invalid phone number: "${input.recipientPhone}" — must be 10–15 digits after normalisation`,
    };
  }

  // 2. Get template definition
  const templateDef = PLATFORM_TEMPLATES[input.templateKey];
  if (!templateDef) {
    return {
      success: false,
      error: `Unknown template key: ${input.templateKey}`,
    };
  }

  // 3. Build ordered body parameters
  let bodyParams: string[];
  try {
    bodyParams = buildBodyParameters(
      templateDef.variables as readonly string[],
      input.variables
    );
  } catch (e: any) {
    return { success: false, error: e.message };
  }

  // 4. Local cache status check
  const cachedTemplate = await schoolDb
    .select({ status: whatsappTemplatesSchema.status })
    .from(whatsappTemplatesSchema)
    .where(eq(whatsappTemplatesSchema.name, templateDef.name))
    .get();

  if (
    cachedTemplate &&
    cachedTemplate.status !== "APPROVED" &&
    cachedTemplate.status !== WhatsappTemplateStatus.APPROVED
  ) {
    return {
      success: false,
      error: `Template "${templateDef.name}" is not approved (current: ${cachedTemplate.status}). Run /whatsapp/templates/sync.`,
    };
  }

  // 5. Deduct credit + insert message row
  let messageId!: number;
  try {
    await schoolDb.transaction(async (tx: any) => {
      await deductWhatsappCredits(tx, 1, whatsappBalanceSchema);

      const [msg] = await tx
        .insert(whatsappMessagesSchema)
        .values({
          recipientUserId: input.recipientUserId ?? null,
          recipientPhone: normalisedPhone,
          recipientName: input.recipientName,
          recipientType: input.recipientType,
          templateName: templateDef.name,
          templateLanguage: templateDef.language,
          templateCategory: templateDef.category,
          variablesJson: JSON.stringify(input.variables),
          status: WhatsappMessageStatus.QUEUED,
          creditsUsed: 1,
          bulkSendId: bulkSendId ?? null,
          triggeredByModule: input.triggeredByModule ?? null,
          triggeredByEntityId: input.triggeredByEntityId ?? null,
        })
        .returning({ id: whatsappMessagesSchema.id });

      messageId = msg.id;
    });
  } catch (e: any) {
    return { success: false, error: e.message };
  }

  // 6. Call Meta Graph API
  const wa = getWhatsappService(env as any);
  try {
    const metaResponse = await wa.sendTemplate({
      to: normalisedPhone,
      templateName: templateDef.name,
      languageCode: templateDef.language,
      bodyParameters: bodyParams,
    });

    const wamid = metaResponse.messages?.[0]?.id ?? null;

    await schoolDb
      .update(whatsappMessagesSchema)
      .set({
        status: WhatsappMessageStatus.SENT,
        waMessageId: wamid,
        sentAt: new Date().toISOString(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(whatsappMessagesSchema.id, messageId));

    // ── NEW: Write wamid → schoolCode index into super DB ─────────────────
    // This is fire-and-forget — a failure here must NOT fail the send.
    // The webhook handler falls back gracefully if the index row is missing.
    if (wamid) {
      const superDb = getCommonDB(env);
      superDb
        .insert(whatsappWamidIndexSchema)
        .values({
          waMessageId: wamid,
          schoolCode,
          schoolId: await resolveSchoolId(superDb, schoolCode),
          sentAt: new Date().toISOString(),
        })
        .run()
        .catch((err: any) =>
          console.error(
            `[WA] wamid index insert failed for ${wamid}:`,
            err.message
          )
        );
    }
    // ─────────────────────────────────────────────────────────────────────

    return { success: true, messageId, wamid: wamid ?? undefined };
  } catch (e: any) {
    const isTemplateErr = e instanceof WhatsappApiError && e.isTemplateError;

    await schoolDb
      .update(whatsappMessagesSchema)
      .set({
        status: isTemplateErr
          ? WhatsappMessageStatus.TEMPLATE_ERROR
          : WhatsappMessageStatus.FAILED,
        failureCode: e instanceof WhatsappApiError ? String(e.code) : "UNKNOWN",
        failureMessage: e.message,
        failedAt: new Date().toISOString(),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(whatsappMessagesSchema.id, messageId));

    return { success: false, messageId, error: e.message };
  }
}

/** Resolve the numeric schoolId from uniqueCode — cached at call site. */
async function resolveSchoolId(
  superDb: any,
  schoolCode: string
): Promise<number> {
  const school = await superDb
    .select({ id: superSchoolsSchema.id })
    .from(superSchoolsSchema)
    .where(eq(superSchoolsSchema.uniqueCode, schoolCode))
    .get();
  return school?.id ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK SEND — initiate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves recipients, checks total credits, deducts them upfront, creates
 * the bulk_sends row and returns immediately. The actual sending happens in
 * executeBulkSend() which is called by the /start endpoint.
 *
 * Credit check is done here (not in executeBulkSend) so the school sees the
 * error before committing to the operation.
 */
export async function initiateBulkSend(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  input: BulkSendInitiateInput & {
    classSectionId?: number;
    userIds?: number[];
    phoneList?: string[];
  },
  createdByUserId: number
): Promise<BulkSendResult> {
  const schoolDb = await getSchoolDB(env, schoolCode);
  const templateDef = PLATFORM_TEMPLATES[input.templateKey];
  if (!templateDef)
    throw new Error(`Unknown template key: ${input.templateKey}`);

  const schoolName = await getSchoolName(schoolDb);
  const recipients = await resolveRecipients(schoolDb, input, schoolName);

  if (recipients.length === 0) {
    throw new Error(
      "No valid recipients found. Ensure the selected students/parents have phone numbers registered."
    );
  }

  const balance = await getWhatsappBalance(schoolDb, whatsappBalanceSchema);
  if (balance.creditsRemaining < recipients.length) {
    throw new Error(
      `Insufficient WhatsApp credits. Need ${recipients.length}, have ${balance.creditsRemaining}. Purchase more from Billing.`
    );
  }

  let bulkSendId!: number;
  await schoolDb.transaction(async (tx: any) => {
    await deductWhatsappCredits(tx, recipients.length, whatsappBalanceSchema);

    const [bulk] = await tx
      .insert(whatsappBulkSendsSchema)
      .values({
        title: input.title,
        templateName: templateDef.name,
        templateCategory: templateDef.category,
        targetType: input.targetType,
        targetJson: JSON.stringify({
          classSectionId: input.classSectionId ?? null,
          userIds: input.userIds ?? null,
          phoneList: input.phoneList ?? null,
        }),
        totalRecipients: recipients.length,
        creditsDeducted: recipients.length,
        status: BulkSendStatus.DRAFT,
        createdBy: createdByUserId,
      })
      .returning({ id: whatsappBulkSendsSchema.id });

    bulkSendId = bulk.id;
  });

  return {
    bulkSendId,
    totalRecipients: recipients.length,
    estimatedCreditCost: recipients.length,
    creditsRemaining: balance.creditsRemaining - recipients.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK SEND — execute (called by /start endpoint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Actually dispatches all messages for a bulk send.
 * Credits are already deducted — this function only sends and updates counts.
 *
 * Sends messages sequentially with a 100ms delay between each to avoid
 * overwhelming Meta's rate limits. For large sends (>1000), consider
 * Cloudflare Queue or DO — for now this covers typical school sizes (50–500).
 *
 * Updates the bulk_send row's sentCount/failedCount as it goes so the
 * progress endpoint returns live data.
 */
export async function executeBulkSend(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  bulkSendId: number
): Promise<{ sent: number; failed: number }> {
  const schoolDb = await getSchoolDB(env, schoolCode);

  const bulkSend = await schoolDb
    .select()
    .from(whatsappBulkSendsSchema)
    .where(eq(whatsappBulkSendsSchema.id, bulkSendId))
    .get();

  if (!bulkSend) throw new Error("Bulk send not found");
  if (bulkSend.status === BulkSendStatus.SENDING)
    throw new Error("Already sending — check /bulk/:id/status for progress");
  if (bulkSend.status === BulkSendStatus.COMPLETED)
    throw new Error("Already completed");
  if (bulkSend.status === BulkSendStatus.CANCELLED)
    throw new Error("Cancelled — cannot restart");

  await schoolDb
    .update(whatsappBulkSendsSchema)
    .set({ status: BulkSendStatus.SENDING, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(whatsappBulkSendsSchema.id, bulkSendId));

  const templateKey = (
    Object.keys(PLATFORM_TEMPLATES) as PlatformTemplateKey[]
  ).find((k) => PLATFORM_TEMPLATES[k].name === bulkSend.templateName);

  if (!templateKey) {
    await schoolDb
      .update(whatsappBulkSendsSchema)
      .set({ status: BulkSendStatus.FAILED, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(whatsappBulkSendsSchema.id, bulkSendId));
    throw new Error(`Cannot find template key for "${bulkSend.templateName}"`);
  }

  const targetJson = JSON.parse(bulkSend.targetJson ?? "{}");
  const schoolName = await getSchoolName(schoolDb);

  const recipients = await resolveRecipients(
    schoolDb,
    {
      templateKey,
      targetType: bulkSend.targetType as any,
      title: bulkSend.title,
      variableResolver: "auto",
      classSectionId: targetJson.classSectionId ?? undefined,
      userIds: targetJson.userIds ?? undefined,
      phoneList: targetJson.phoneList ?? undefined,
    },
    schoolName
  );

  let sentCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    const result = await sendOneMessage(
      env,
      schoolCode,
      {
        templateKey,
        recipientPhone: recipient.phone,
        recipientName: recipient.name,
        recipientType: recipient.type as any,
        recipientUserId: recipient.userId,
        variables: recipient.variables,
        triggeredByModule: "bulk",
        triggeredByEntityId: bulkSendId,
      },
      bulkSendId
    );

    result.success ? sentCount++ : failedCount++;

    if ((sentCount + failedCount) % 10 === 0) {
      await schoolDb
        .update(whatsappBulkSendsSchema)
        .set({ sentCount, failedCount, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(whatsappBulkSendsSchema.id, bulkSendId));
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  const finalStatus =
    failedCount === 0
      ? BulkSendStatus.COMPLETED
      : sentCount === 0
      ? BulkSendStatus.FAILED
      : BulkSendStatus.PARTIAL;

  await schoolDb
    .update(whatsappBulkSendsSchema)
    .set({
      status: finalStatus,
      sentCount,
      failedCount,
      completedAt: new Date().toISOString(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(whatsappBulkSendsSchema.id, bulkSendId));

  return { sent: sentCount, failed: failedCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

interface Recipient {
  phone: string;
  name: string;
  type: string;
  userId?: number;
  variables: Record<string, string>;
}

async function resolveRecipients(
  schoolDb: any,
  input: {
    templateKey: PlatformTemplateKey;
    targetType: string;
    title?: string;
    classSectionId?: number;
    userIds?: number[];
    phoneList?: string[];
    variableResolver?: string;
  },
  schoolName: string
): Promise<Recipient[]> {
  switch (input.targetType) {
    case "ALL_PARENTS":
      return resolveAllParents(schoolDb, schoolName);
    case "CLASS_SECTION_PARENTS":
      if (!input.classSectionId)
        throw new Error("classSectionId required for CLASS_SECTION_PARENTS");
      return resolveClassSectionParents(
        schoolDb,
        input.classSectionId,
        schoolName
      );
    case "ALL_STUDENTS":
      return resolveAllStudents(schoolDb, schoolName);
    case "CLASS_SECTION_STUDENTS":
      if (!input.classSectionId)
        throw new Error("classSectionId required for CLASS_SECTION_STUDENTS");
      return resolveClassSectionStudents(
        schoolDb,
        input.classSectionId,
        schoolName
      );
    case "ALL_STAFF":
      return resolveAllStaff(schoolDb, schoolName);
    case "CUSTOM_USER_LIST":
      if (!input.userIds?.length)
        throw new Error("userIds required for CUSTOM_USER_LIST");
      return resolveUserList(schoolDb, input.userIds, schoolName);
    case "CUSTOM_PHONE_LIST":
      if (!input.phoneList?.length)
        throw new Error("phoneList required for CUSTOM_PHONE_LIST");
      return input.phoneList
        .map((p) => normalisePhone(p))
        .filter((p) => isValidPhone(p))
        .map((phone) => ({
          phone,
          name: "Recipient",
          type: "EXTERNAL",
          variables: makeDefaultVars("Recipient", schoolName),
        }));
    default:
      throw new Error(`Unknown targetType: "${input.targetType}"`);
  }
}

async function resolveAllParents(
  schoolDb: any,
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
    })
    .from(schoolUsersSchema)
    .where(
      and(
        eq(schoolUsersSchema.isActive, true),
        eq(schoolUsersSchema.primaryRole, "STUDENT_PARENT")
      )
    )
    .all();

  return rows
    .filter((r: any) => r.phone && isValidPhone(normalisePhone(r.phone)))
    .map((r: any) => ({
      phone: normalisePhone(r.phone),
      name: r.name || "Parent",
      type: "PARENT",
      userId: r.id,
      variables: makeDefaultVars(r.name || "Parent", schoolName),
    }));
}

async function resolveClassSectionParents(
  schoolDb: any,
  classSectionId: number,
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      parentId: schoolUsersSchema.id,
      parentName: schoolUsersSchema.name,
      parentPhone: schoolUsersSchema.phone,
    })
    .from(schoolStudentEnrollmentsSchema)
    .leftJoin(
      studentParentsSchema,
      eq(
        schoolStudentEnrollmentsSchema.studentId,
        studentParentsSchema.studentId
      )
    )
    .leftJoin(
      schoolUsersSchema,
      eq(studentParentsSchema.parentId, schoolUsersSchema.id)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .all();

  const seen = new Set<number>();
  const result: Recipient[] = [];
  for (const r of rows) {
    if (!r.parentId || !r.parentPhone) continue;
    if (!isValidPhone(normalisePhone(r.parentPhone))) continue;
    if (seen.has(r.parentId)) continue;
    seen.add(r.parentId);
    result.push({
      phone: normalisePhone(r.parentPhone),
      name: r.parentName || "Parent",
      type: "PARENT",
      userId: r.parentId,
      variables: makeDefaultVars(r.parentName || "Parent", schoolName),
    });
  }
  return result;
}

async function resolveAllStudents(
  schoolDb: any,
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
    })
    .from(schoolUsersSchema)
    .where(
      and(
        eq(schoolUsersSchema.isActive, true),
        eq(schoolUsersSchema.primaryRole, "STUDENT")
      )
    )
    .all();

  return rows
    .filter((r: any) => r.phone && isValidPhone(normalisePhone(r.phone)))
    .map((r: any) => ({
      phone: normalisePhone(r.phone),
      name: r.name || "Student",
      type: "STUDENT",
      userId: r.id,
      variables: makeDefaultVars(r.name || "Student", schoolName),
    }));
}

async function resolveClassSectionStudents(
  schoolDb: any,
  classSectionId: number,
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
    })
    .from(schoolStudentEnrollmentsSchema)
    .leftJoin(
      schoolUsersSchema,
      eq(schoolStudentEnrollmentsSchema.studentId, schoolUsersSchema.id)
    )
    .where(
      and(
        eq(schoolStudentEnrollmentsSchema.classSectionId, classSectionId),
        eq(schoolStudentEnrollmentsSchema.isActive, true)
      )
    )
    .all();

  return rows
    .filter((r: any) => r.phone && isValidPhone(normalisePhone(r.phone)))
    .map((r: any) => ({
      phone: normalisePhone(r.phone),
      name: r.name || "Student",
      type: "STUDENT",
      userId: r.id,
      variables: makeDefaultVars(r.name || "Student", schoolName),
    }));
}

async function resolveAllStaff(
  schoolDb: any,
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
      primaryRole: schoolUsersSchema.primaryRole,
    })
    .from(schoolUsersSchema)
    .where(eq(schoolUsersSchema.isActive, true))
    .all();

  return rows
    .filter(
      (r: any) =>
        r.phone &&
        isValidPhone(normalisePhone(r.phone)) &&
        r.primaryRole !== "STUDENT" &&
        r.primaryRole !== "STUDENT_PARENT"
    )
    .map((r: any) => ({
      phone: normalisePhone(r.phone),
      name: r.name || "Staff",
      type: "STAFF",
      userId: r.id,
      variables: makeDefaultVars(r.name || "Staff", schoolName),
    }));
}

async function resolveUserList(
  schoolDb: any,
  userIds: number[],
  schoolName: string
): Promise<Recipient[]> {
  const rows = await schoolDb
    .select({
      id: schoolUsersSchema.id,
      name: schoolUsersSchema.name,
      phone: schoolUsersSchema.phone,
      primaryRole: schoolUsersSchema.primaryRole,
    })
    .from(schoolUsersSchema)
    .where(inArray(schoolUsersSchema.id, userIds))
    .all();

  return rows
    .filter((r: any) => r.phone && isValidPhone(normalisePhone(r.phone)))
    .map((r: any) => ({
      phone: normalisePhone(r.phone),
      name: r.name || "User",
      type:
        r.primaryRole === "STUDENT_PARENT"
          ? "PARENT"
          : r.primaryRole === "STUDENT"
          ? "STUDENT"
          : "STAFF",
      userId: r.id,
      variables: makeDefaultVars(r.name || "User", schoolName),
    }));
}

/**
 * Default variable map covering ALL variable slots across all 14 templates.
 * Module-specific helpers override the relevant slots with real values.
 * Empty strings are safe — Meta renders them as-is (blank).
 */
function makeDefaultVars(
  recipientName: string,
  schoolName: string
): Record<string, string> {
  return {
    // Identity (shared across templates)
    parent_name: recipientName,
    recipient_name: recipientName,
    student_name: recipientName,
    student_name_2: recipientName,
    school_name: schoolName,
    school_name_2: schoolName,
    school_name_3: schoolName,
    school_name_footer: schoolName,
    school_name_team: schoolName,
    contact: "",

    // Fee-related
    roll_number: "",
    month: "",
    fee_breakdown: "",
    total_due: "",
    due_date: "",
    receipt_number: "",
    payment_date: "",
    payment_mode: "",
    class_section: "",
    academic_year: "",
    fees_paid_breakdown: "",
    amount_paid: "",
    total_annual_fee: "",
    total_paid_ytd: "",
    concession_given: "",
    balance_remaining: "",
    overdue_breakdown: "",
    amount_overdue: "",
    was_due_on: "",
    days_overdue: "",
    fee_type: "",
    fee_description: "",
    amount: "",
    applicable_period: "",
    is_mandatory: "",

    // Exam-related
    exam_name: "",
    exam_name_2: "",
    exam_type: "",
    subject_schedule: "",
    exam_start_date: "",
    exam_end_date: "",
    report_time: "",
    first_exam_date: "",
    first_exam_time: "",
    venue: "",
    portal_url: "",
    result_summary: "",
    total_marks: "",
    total_out_of: "",
    percentage: "",
    overall_grade: "",
    result_status: "",

    // Attendance-related
    date: "",
    status: "",
    note: "",
    working_days: "",
    present_days: "",
    absent_days: "",
    leave_days: "",
    attendance_pct: "",
    required_pct: "",
    shortfall_pct: "",

    // Admission-related
    admission_number: "",
    admission_date: "",

    // Assignment-related
    subject: "",
    teacher_name: "",
    assignment_title: "",
    assignment_type: "",
    max_marks: "",
    description: "",

    // General notification / holiday / PTM
    regarding: "",
    notice_details: "",
    closed_on: "",
    reason: "",
    classes_resume: "",
    optional_message: "",
    ptm_date: "",
    time_slot: "",
  };
}

async function getSchoolName(schoolDb: any): Promise<string> {
  const { schoolsSchema } = await import("../../../db/schemas/school/schools");
  const school = await schoolDb
    .select({ name: schoolsSchema.name })
    .from(schoolsSchema)
    .get();
  return school?.name ?? "Your School";
}

// ─────────────────────────────────────────────────────────────────────────────
// READ — history, bulk list, bulk status
// ─────────────────────────────────────────────────────────────────────────────

export async function getMessageHistory(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  params: { limit?: number; offset?: number; status?: string; module?: string; bulkSendId?: number; }
) {
  const schoolDb = await getSchoolDB(env, schoolCode);
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = params.offset ?? 0;

  const conditions: any[] = [];
  if (params.status)
    conditions.push(eq(whatsappMessagesSchema.status, params.status as any));
  if (params.module)
    conditions.push(
      eq(whatsappMessagesSchema.triggeredByModule, params.module)
    );

  // whatsapp_messages.bulk_send_id is stamped on every row created inside
  // executeBulkSend() → sendOneMessage(bulkSendId). This lets the bulk-send
  // detail screen show ONLY the messages belonging to that one batch instead
  // of every bulk-triggered message across the school.
  if (params.bulkSendId !== undefined && !Number.isNaN(params.bulkSendId)) {
    conditions.push(eq(whatsappMessagesSchema.bulkSendId, params.bulkSendId));
  }

  return schoolDb
    .select({
      id: whatsappMessagesSchema.id,
      recipientName: whatsappMessagesSchema.recipientName,
      recipientPhone: whatsappMessagesSchema.recipientPhone,
      recipientType: whatsappMessagesSchema.recipientType,
      templateName: whatsappMessagesSchema.templateName,
      templateCategory: whatsappMessagesSchema.templateCategory,
      status: whatsappMessagesSchema.status,
      waMessageId: whatsappMessagesSchema.waMessageId,
      failureCode: whatsappMessagesSchema.failureCode,
      failureMessage: whatsappMessagesSchema.failureMessage,
      creditsUsed: whatsappMessagesSchema.creditsUsed,
      triggeredByModule: whatsappMessagesSchema.triggeredByModule,
      bulkSendId: whatsappMessagesSchema.bulkSendId,
      sentAt: whatsappMessagesSchema.sentAt,
      deliveredAt: whatsappMessagesSchema.deliveredAt,
      readAt: whatsappMessagesSchema.readAt,
      createdAt: whatsappMessagesSchema.createdAt,
    })
    .from(whatsappMessagesSchema)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(whatsappMessagesSchema.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

export async function getBulkSendStatus(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  bulkSendId: number
) {
  const schoolDb = await getSchoolDB(env, schoolCode);
  return schoolDb
    .select()
    .from(whatsappBulkSendsSchema)
    .where(eq(whatsappBulkSendsSchema.id, bulkSendId))
    .get();
}

export async function getBulkSendList(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  limit = 20,
  offset = 0
) {
  const schoolDb = await getSchoolDB(env, schoolCode);
  return schoolDb
    .select()
    .from(whatsappBulkSendsSchema)
    .orderBy(desc(whatsappBulkSendsSchema.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE INTEGRATION HELPERS — fire-and-forget safe, called from other modules
// ─────────────────────────────────────────────────────────────────────────────

/** Absent today notification — uses STUDENT_ABSENT_TODAY template. */
export async function sendAttendanceNotification(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  p: {
    parentUserId: number;
    parentName: string;
    parentPhone: string;
    studentName: string;
    date: string;
    classSection: string;
    status: string;
    schoolName: string;
    enrollmentId?: number;
    note?: string;
  }
): Promise<SendMessageResult> {
  return sendOneMessage(env, schoolCode, {
    templateKey: "STUDENT_ABSENT_TODAY",
    recipientPhone: p.parentPhone,
    recipientName: p.parentName,
    recipientType: "PARENT",
    recipientUserId: p.parentUserId,
    variables: {
      school_name: p.schoolName, // {{1}}
      student_name: p.studentName, // {{2}}
      student_name_2: p.studentName, // {{3}}
      class_section: p.classSection, // {{4}}
      date: p.date, // {{5}}
      status: p.status, // {{6}}
      note: p.note ?? "No prior intimation received", // {{7}}
      contact: "", // {{8}} — school fills via settings
    },
    triggeredByModule: "attendance",
    triggeredByEntityId: p.enrollmentId,
  });
}

/** Monthly fee due reminder — uses MONTHLY_FEE_DUE template. */
export async function sendFeeReminder(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  p: {
    parentUserId: number;
    parentName: string;
    parentPhone: string;
    studentName: string;
    classSection: string;
    rollNumber: string;
    month: string;
    feeBreakdown: string;
    totalDue: string;
    dueDate: string;
    schoolName: string;
    contact: string;
    feeStructureId?: number;
  }
): Promise<SendMessageResult> {
  return sendOneMessage(env, schoolCode, {
    templateKey: "MONTHLY_FEE_DUE",
    recipientPhone: p.parentPhone,
    recipientName: p.parentName,
    recipientType: "PARENT",
    recipientUserId: p.parentUserId,
    variables: {
      parent_name: p.studentName, // {{1}}
      school_name: p.schoolName, // {{2}}
      student_name: p.studentName, // {{3}}
      class_section: p.classSection, // {{4}}
      roll_number: p.rollNumber, // {{5}}
      month: p.month, // {{6}}
      fee_breakdown: p.feeBreakdown, // {{7}}
      total_due: p.totalDue, // {{8}}
      due_date: p.dueDate, // {{9}}
      contact: p.contact, // {{10}}
      school_name_footer: p.schoolName, // {{11}}
    },
    triggeredByModule: "fees",
    triggeredByEntityId: p.feeStructureId,
  });
}

/** Fee payment confirmed receipt — uses FEE_PAYMENT_CONFIRMED template. */
export async function sendFeeReceipt(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  p: {
    parentUserId: number;
    parentName: string;
    parentPhone: string;
    studentName: string;
    classSection: string;
    academicYear: string;
    receiptNumber: string;
    paymentDate: string;
    paymentMode: string;
    feesPaidBreakdown: string;
    amountPaid: string;
    totalAnnualFee: string;
    totalPaidYtd: string;
    concessionGiven: string;
    balanceRemaining: string;
    schoolName: string;
    contact: string;
    feePaymentId?: number;
  }
): Promise<SendMessageResult> {
  return sendOneMessage(env, schoolCode, {
    templateKey: "FEE_PAYMENT_CONFIRMED",
    recipientPhone: p.parentPhone,
    recipientName: p.parentName,
    recipientType: "PARENT",
    recipientUserId: p.parentUserId,
    variables: {
      parent_name: p.studentName, // {{1}}
      school_name: p.schoolName, // {{2}}
      receipt_number: p.receiptNumber, // {{3}}
      payment_date: p.paymentDate, // {{4}}
      payment_mode: p.paymentMode, // {{5}}
      student_name: p.studentName, // {{6}}
      class_section: p.classSection, // {{7}}
      academic_year: p.academicYear, // {{8}}
      fees_paid_breakdown: p.feesPaidBreakdown, // {{9}}
      amount_paid: p.amountPaid, // {{10}}
      total_annual_fee: p.totalAnnualFee, // {{11}}
      total_paid_ytd: p.totalPaidYtd, // {{12}}
      concession_given: p.concessionGiven, // {{13}}
      balance_remaining: p.balanceRemaining, // {{14}}
      school_name_team: p.schoolName, // {{15}}
      contact: p.contact, // {{16}}
    },
    triggeredByModule: "fees",
    triggeredByEntityId: p.feePaymentId,
  });
}

/** Exam result — uses RESULT_PUBLISHED template. */
export async function sendExamResult(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  p: {
    parentUserId: number;
    parentName: string;
    parentPhone: string;
    studentName: string;
    classSection: string;
    rollNumber: string;
    examName: string;
    academicYear: string;
    resultSummary: string;
    totalMarks: string;
    totalOutOf: string;
    percentage: string;
    overallGrade: string;
    resultStatus: string;
    portalUrl: string;
    schoolName: string;
    examId?: number;
  }
): Promise<SendMessageResult> {
  return sendOneMessage(env, schoolCode, {
    templateKey: "RESULT_PUBLISHED",
    recipientPhone: p.parentPhone,
    recipientName: p.parentName,
    recipientType: "PARENT",
    recipientUserId: p.parentUserId,
    variables: {
      school_name: p.schoolName, // {{1}}
      exam_name: p.examName, // {{2}}
      student_name: p.studentName, // {{3}}
      class_section: p.classSection, // {{4}}
      roll_number: p.rollNumber, // {{5}}
      exam_name_2: p.examName, // {{6}}
      academic_year: p.academicYear, // {{7}}
      result_summary: p.resultSummary, // {{8}}
      total_marks: p.totalMarks, // {{9}}
      total_out_of: p.totalOutOf, // {{10}}
      percentage: p.percentage, // {{11}}
      overall_grade: p.overallGrade, // {{12}}
      result_status: p.resultStatus, // {{13}}
      portal_url: p.portalUrl, // {{14}}
    },
    triggeredByModule: "exams",
    triggeredByEntityId: p.examId,
  });
}

/** Assignment due reminder — uses ASSIGNMENT_DUE_REMINDER template. */
export async function sendAssignmentReminder(
  env: SchoolEnv["Bindings"],
  schoolCode: string,
  p: {
    parentUserId: number;
    parentName: string;
    parentPhone: string;
    studentName: string;
    classSection: string;
    subject: string;
    teacherName: string;
    assignmentTitle: string;
    assignmentType: string;
    dueDate: string;
    maxMarks: string;
    isMandatory: string;
    description: string;
    schoolName: string;
    assignmentId?: number;
  }
): Promise<SendMessageResult> {
  return sendOneMessage(env, schoolCode, {
    templateKey: "ASSIGNMENT_DUE_REMINDER",
    recipientPhone: p.parentPhone,
    recipientName: p.parentName,
    recipientType: "PARENT",
    recipientUserId: p.parentUserId,
    variables: {
      student_name: p.studentName, // {{1}}
      school_name: p.schoolName, // {{2}}
      student_name_2: p.studentName, // {{3}}
      class_section: p.classSection, // {{4}}
      subject: p.subject, // {{5}}
      teacher_name: p.teacherName, // {{6}}
      assignment_title: p.assignmentTitle, // {{7}}
      assignment_type: p.assignmentType, // {{8}}
      due_date: p.dueDate, // {{9}}
      max_marks: p.maxMarks, // {{10}}
      is_mandatory: p.isMandatory, // {{11}}
      description: p.description, // {{12}}
      school_name_2: p.schoolName, // {{13}}
    },
    triggeredByModule: "assignments",
    triggeredByEntityId: p.assignmentId,
  });
}
