// src/modules/super/contact-messages/services.ts

import { and, desc, eq, sql } from "drizzle-orm";
import { ContactCategoryType, ContactMessageStatusType, schoolContactMessagesSchema } from "../../../db/schemas/super/school-contact-messages";

// ── List ──────────────────────────────────────────────────────────────────────

export async function listContactMessages(
  db: any,
  filters: { status?: string; category?: string }
) {
  let query = db
    .select()
    .from(schoolContactMessagesSchema)
    .orderBy(desc(schoolContactMessagesSchema.createdAt));

  const conditions = [];

  if (filters.status) {
    conditions.push(eq(schoolContactMessagesSchema.status, filters.status as ContactMessageStatusType));
  }
  if (filters.category) {
    conditions.push(eq(schoolContactMessagesSchema.category, filters.category as ContactCategoryType));
  }

  if (conditions.length > 0) {
    return query.where(and(...conditions)).all();
  }

  return query.all();
}

// ── Get single ────────────────────────────────────────────────────────────────

export async function getContactMessageById(db: any, id: number) {
  return db
    .select()
    .from(schoolContactMessagesSchema)
    .where(eq(schoolContactMessagesSchema.id, id))
    .get();
}

// ── Update status ─────────────────────────────────────────────────────────────

export async function updateContactStatus(
  db: any,
  id: number,
  status: string,
  resolvedBy: number
) {
  const updateData: any = {
    status,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };

  if (status === "RESOLVED" || status === "CLOSED") {
    updateData.resolvedBy = resolvedBy;
    updateData.resolvedAt = new Date().toISOString();
  }

  await db
    .update(schoolContactMessagesSchema)
    .set(updateData)
    .where(eq(schoolContactMessagesSchema.id, id));
}

// ── Update notes ──────────────────────────────────────────────────────────────

export async function updateContactNotes(
  db: any,
  id: number,
  internalNotes: string
) {
  await db
    .update(schoolContactMessagesSchema)
    .set({ internalNotes, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(schoolContactMessagesSchema.id, id));
}
