// src/modules/webhooks/whatsapp/handler.ts
//
// Processes ALL webhook events from Meta's WhatsApp Business Platform.
//
// ── CRITICAL RULES ─────────────────────────────────────────────────────────
// 1. Always return HTTP 200 immediately — even on errors. Non-200 causes Meta
//    to retry with exponential backoff, creating noise and duplicate processing.
// 2. Webhook payloads can contain multiple entries and multiple changes per
//    entry. Process ALL of them — don't stop on first item.
// 3. Status events can arrive out of order (delivered before sent, etc.)
//    — always check current status before downgrading it.
// 4. The phone_number_id in metadata tells us WHICH of our phone numbers
//    received the event. Currently we have one, but structure for many.
// 5. Match inbound messages to a school by resolving which school owns the
//    phone number receiving the message — for now we have one WABA/number
//    so all events belong to the same "platform" and we route by the sender's
//    phone matching a school_users.phone across all school DBs.
// ───────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { getCommonDB } from "../../../db";
import { getSchoolDB } from "../../../db/school-client";
import {
  schoolsSchema,
  whatsappWamidIndexSchema,
} from "../../../db/schemas/super";
import {
  schoolUsersSchema,
  whatsappBulkSendsSchema,
  whatsappInboundMessagesSchema,
  whatsappMessagesSchema,
} from "../../../db/schemas/school";
import {
  MetaWebhookPayload,
  MetaInboundMessage,
  MetaMessageStatus,
  WhatsappMessageStatus,
} from "../../../types/whatsapp";
import { Env } from "../../../types/common-types";

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export async function handleWhatsappWebhook(
  env: Env["Bindings"],
  rawBody: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 200, body: { received: false, error: "Invalid JSON" } };
  }

  if (payload.object !== "whatsapp_business_account") {
    return { status: 200, body: { received: true, action: "ignored_non_wa" } };
  }

  const results: string[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;

      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id ?? "";

      for (const status of value.statuses ?? []) {
        try {
          await handleStatusUpdate(env, status, phoneNumberId);
          results.push(`status:${status.id}:${status.status}`);
        } catch (err: any) {
          console.error(
            `[WA Webhook] Status update error for ${status.id}:`,
            err.message
          );
        }
      }

      const contactsMap = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        contactsMap.set(contact.wa_id, contact.profile?.name ?? "");
      }

      for (const message of value.messages ?? []) {
        const senderName = contactsMap.get(message.from) ?? "";
        try {
          await handleInboundMessage(env, message, senderName, phoneNumberId);
          results.push(`inbound:${message.id}`);
        } catch (err: any) {
          console.error(
            `[WA Webhook] Inbound message error for ${message.id}:`,
            err.message
          );
        }
      }
    }
  }

  return {
    status: 200,
    body: { received: true, processed: results.length, results },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS UPDATE HANDLER — O(1) wamid index lookup
// ─────────────────────────────────────────────────────────────────────────────

const statusOrder: Record<string, number> = {
  [WhatsappMessageStatus.QUEUED]: 0,
  [WhatsappMessageStatus.SENT]: 1,
  [WhatsappMessageStatus.DELIVERED]: 2,
  [WhatsappMessageStatus.READ]: 3,
  [WhatsappMessageStatus.FAILED]: 0,
  [WhatsappMessageStatus.TEMPLATE_ERROR]: 0,
};

const metaToInternalStatus: Record<string, string | null> = {
  sent: WhatsappMessageStatus.SENT,
  delivered: WhatsappMessageStatus.DELIVERED,
  read: WhatsappMessageStatus.READ,
  failed: WhatsappMessageStatus.FAILED,
  deleted: null,
};

async function handleStatusUpdate(
  env: Env["Bindings"],
  statusEvent: MetaMessageStatus,
  phoneNumberId: string
): Promise<void> {
  const wamid = statusEvent.id;
  const mappedStatus = metaToInternalStatus[statusEvent.status];

  if (!mappedStatus) {
    console.log(
      `[WA Webhook] Ignoring status "${statusEvent.status}" for wamid ${wamid}`
    );
    return;
  }

  // ── Step 1: O(1) lookup via super DB wamid index ─────────────────────────
  const superDb = getCommonDB(env);
  const indexRow = await superDb
    .select({
      schoolCode: whatsappWamidIndexSchema.schoolCode,
    })
    .from(whatsappWamidIndexSchema)
    .where(eq(whatsappWamidIndexSchema.waMessageId, wamid))
    .get();

  if (indexRow?.schoolCode) {
    // Fast path — found in index
    await updateMessageStatus(
      env,
      indexRow.schoolCode,
      wamid,
      mappedStatus,
      statusEvent
    );
    return;
  }

  // ── Step 2: Fallback — scan active schools (for messages sent before index
  //    was deployed, or if the index insert failed transiently).
  //    This path will become a no-op once all historical messages age out.
  console.warn(
    `[WA Webhook] wamid ${wamid} not in index — falling back to full school scan`
  );

  const activeSchools = await superDb
    .select({ uniqueCode: schoolsSchema.uniqueCode })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.isActive, true))
    .all();

  for (const school of activeSchools) {
    try {
      const found = await updateMessageStatus(
        env,
        school.uniqueCode,
        wamid,
        mappedStatus,
        statusEvent
      );
      if (found) {
        // Back-fill the index so subsequent events for the same wamid are fast
        const schoolRecord = await superDb
          .select({ id: schoolsSchema.id })
          .from(schoolsSchema)
          .where(eq(schoolsSchema.uniqueCode, school.uniqueCode))
          .get();

        if (schoolRecord) {
          superDb
            .insert(whatsappWamidIndexSchema)
            .values({
              waMessageId: wamid,
              schoolCode: school.uniqueCode,
              schoolId: schoolRecord.id,
              sentAt: new Date().toISOString(),
            })
            .run()
            .catch(() => {
              // Ignore duplicate insert errors — another webhook event may have
              // already back-filled this row between our SELECT and INSERT.
            });
        }
        return;
      }
    } catch {
      continue;
    }
  }

  console.warn(`[WA Webhook] wamid ${wamid} not found in any school DB`);
}

/**
 * Updates the status of the whatsapp_messages row matching the wamid
 * in the given school's Turso DB.
 *
 * Returns true if the row was found (and updated or skipped), false if not
 * found in this school's DB.
 */
async function updateMessageStatus(
  env: Env["Bindings"],
  schoolCode: string,
  wamid: string,
  mappedStatus: string,
  statusEvent: MetaMessageStatus
): Promise<boolean> {
  const schoolDb = await getSchoolDB(env, schoolCode);

  const existing = await schoolDb
    .select({
      id: whatsappMessagesSchema.id,
      status: whatsappMessagesSchema.status,
      bulkSendId: whatsappMessagesSchema.bulkSendId,
    })
    .from(whatsappMessagesSchema)
    .where(eq(whatsappMessagesSchema.waMessageId, wamid))
    .get();

  if (!existing) return false;

  // Guard: never downgrade status
  const currentOrder = statusOrder[existing.status] ?? 0;
  const newOrder = statusOrder[mappedStatus] ?? 0;

  if (
    mappedStatus !== WhatsappMessageStatus.FAILED &&
    newOrder <= currentOrder
  ) {
    console.log(
      `[WA Webhook] Skipping status downgrade: ${existing.status} → ${mappedStatus} for wamid ${wamid}`
    );
    return true; // Found — just didn't update
  }

  const now = new Date().toISOString();
  const updateFields: Record<string, any> = {
    status: mappedStatus,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  if (mappedStatus === WhatsappMessageStatus.DELIVERED) {
    updateFields.deliveredAt = now;
  } else if (mappedStatus === WhatsappMessageStatus.READ) {
    updateFields.readAt = now;
  } else if (mappedStatus === WhatsappMessageStatus.FAILED) {
    updateFields.failedAt = now;
    const err = statusEvent.errors?.[0];
    if (err) {
      updateFields.failureCode = String(err.code);
      updateFields.failureMessage =
        err.error_data?.details ?? err.title ?? err.message;
    }
  }

  await schoolDb
    .update(whatsappMessagesSchema)
    .set(updateFields)
    .where(eq(whatsappMessagesSchema.id, existing.id));

  // Update bulk send counters
  if (existing.bulkSendId) {
    if (mappedStatus === WhatsappMessageStatus.DELIVERED) {
      await schoolDb
        .update(whatsappBulkSendsSchema)
        .set({
          deliveredCount: sql`${whatsappBulkSendsSchema.deliveredCount} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(whatsappBulkSendsSchema.id, existing.bulkSendId));
    } else if (mappedStatus === WhatsappMessageStatus.FAILED) {
      await schoolDb
        .update(whatsappBulkSendsSchema)
        .set({
          failedCount: sql`${whatsappBulkSendsSchema.failedCount} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(whatsappBulkSendsSchema.id, existing.bulkSendId));
    }
  }

  console.log(
    `[WA Webhook] Updated wamid ${wamid} → ${mappedStatus} for school ${schoolCode}`
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGE HANDLER (unchanged logic, same as original)
// ─────────────────────────────────────────────────────────────────────────────

async function handleInboundMessage(
  env: Env["Bindings"],
  message: MetaInboundMessage,
  senderName: string,
  phoneNumberId: string
): Promise<void> {
  const fromPhone = message.from;

  const db = getCommonDB(env);
  const activeSchools = await db
    .select({ uniqueCode: schoolsSchema.uniqueCode })
    .from(schoolsSchema)
    .where(eq(schoolsSchema.isActive, true))
    .all();

  for (const school of activeSchools) {
    try {
      const schoolDb = await getSchoolDB(env, school.uniqueCode);

      const alreadyLogged = await schoolDb
        .select({ id: whatsappInboundMessagesSchema.id })
        .from(whatsappInboundMessagesSchema)
        .where(eq(whatsappInboundMessagesSchema.waMessageId, message.id))
        .get();

      if (alreadyLogged) {
        console.log(`[WA Webhook] Duplicate inbound ${message.id} — skipping`);
        return;
      }

      const phoneSuffixes = [fromPhone, fromPhone.slice(-10)];
      let fromUserId: number | null = null;
      let fromUserName: string | null = senderName || null;

      for (const phoneSuffix of phoneSuffixes) {
        const user = await schoolDb
          .select({
            id: schoolUsersSchema.id,
            name: schoolUsersSchema.name,
            phone: schoolUsersSchema.phone,
          })
          .from(schoolUsersSchema)
          .where(eq(schoolUsersSchema.phone, phoneSuffix))
          .get();

        if (user) {
          fromUserId = user.id;
          fromUserName = fromUserName || user.name;
          break;
        }
      }

      const isLastSchool = school === activeSchools[activeSchools.length - 1];
      if (!fromUserId && !isLastSchool) continue;

      await schoolDb.insert(whatsappInboundMessagesSchema).values({
        fromPhone,
        fromName: fromUserName || senderName || null,
        fromUserId: fromUserId || null,
        waMessageId: message.id,
        messageType: message.type,
        textBody: message.text?.body ?? null,
        mediaId:
          message.image?.id ??
          message.document?.id ??
          message.audio?.id ??
          null,
        replyToWaMessageId: message.context?.id ?? null,
        receivedAt: message.timestamp,
      });

      console.log(
        `[WA Webhook] Logged inbound ${message.id} from ${fromPhone} → school ${school.uniqueCode}`
      );

      if (fromUserId) return;
    } catch (err: any) {
      console.error(
        `[WA Webhook] Error logging inbound for school ${school.uniqueCode}:`,
        err.message
      );
      continue;
    }
  }
}
