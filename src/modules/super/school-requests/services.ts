// src/modules/super/school-requests/services.ts

import { desc, eq, sql } from "drizzle-orm";
import {
  schoolRegistrationRequestsSchema,
  RegistrationRequestStatus,
  RegistrationRequestStatusType,
} from "../../../db/schemas/super/school-registration-requests";

// ── List ──────────────────────────────────────────────────────────────────────

export async function listRegistrationRequests(db: any, status?: string) {
  const query = db
    .select()
    .from(schoolRegistrationRequestsSchema)
    .orderBy(desc(schoolRegistrationRequestsSchema.createdAt));

  if (status) {
    return query
      .where(eq(schoolRegistrationRequestsSchema.status, status as RegistrationRequestStatusType))
      .all();
  }

  return query.all();
}

// ── Get single ────────────────────────────────────────────────────────────────

export async function getRegistrationRequestById(db: any, id: number) {
  return db
    .select()
    .from(schoolRegistrationRequestsSchema)
    .where(eq(schoolRegistrationRequestsSchema.id, id))
    .get();
}

// ── Update status ─────────────────────────────────────────────────────────────

export async function updateRequestStatus(
  db: any,
  id: number,
  status: string,
  reviewedBy: number
) {
  await db
    .update(schoolRegistrationRequestsSchema)
    .set({
      status,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolRegistrationRequestsSchema.id, id));
}

// ── Update notes ──────────────────────────────────────────────────────────────

export async function updateRequestNotes(
  db: any,
  id: number,
  internalNotes: string
) {
  await db
    .update(schoolRegistrationRequestsSchema)
    .set({
      internalNotes,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(schoolRegistrationRequestsSchema.id, id));
}
