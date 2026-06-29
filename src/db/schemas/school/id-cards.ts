// src/db/schemas/school/id-cards.ts

import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolUsersSchema } from "./school-users";
import { schoolStudentEnrollmentsSchema } from "./school-student-enrollments";
import {
  idCardTemplatesSchema,
  IdCardHolderTypeValue,
} from "./id-card-templates";

// ─────────────────────────────────────────────────────────────────────────────
// ID CARD STATUS
//
// ACTIVE    → Currently valid. Verification endpoint returns "valid".
// REVOKED   → Manually invalidated (card lost/damaged/student left mid-year
//             but a replacement hasn't been issued yet). Verification
//             endpoint returns "invalid" — does NOT delete the row, audit
//             trail is preserved (same pattern as fee_concessions revocation).
// EXPIRED   → Past validUntil. Computed at read-time by comparing validUntil
//             to now; we additionally persist this on a periodic basis so
//             list/filter queries can filter by status without a date compare
//             on every row. Source of truth is still validUntil.
// REISSUED  → Superseded by a newer card row (see reissue flow). Kept purely
//             for history; the NEW row is what's ACTIVE.
// ─────────────────────────────────────────────────────────────────────────────

export const IdCardStatus = {
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
  REISSUED: "REISSUED",
} as const;

export type IdCardStatusValue =
  (typeof IdCardStatus)[keyof typeof IdCardStatus];

export const ALL_ID_CARD_STATUSES = [
  IdCardStatus.ACTIVE,
  IdCardStatus.REVOKED,
  IdCardStatus.EXPIRED,
  IdCardStatus.REISSUED,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

export const idCardsSchema = sqliteTable(
  "id_cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id")
      .references(() => schoolsSchema.id, { onDelete: "cascade" })
      .notNull()
      .default(1),

    holderType: text("holder_type").$type<IdCardHolderTypeValue>().notNull(),

    holderUserId: integer("holder_user_id")
      .references(() => schoolUsersSchema.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * Only set when holderType = STUDENT. Class/section/roll number live on
     * the enrollment, not the user — pinning the enrollment at issue time
     * means a card stays historically accurate even if the student is later
     * promoted/moved to a different class-section mid-year. A new academic
     * year means a NEW card (new enrollment), not an edit to this one.
     */
    enrollmentId: integer("enrollment_id").references(
      () => schoolStudentEnrollmentsSchema.id,
      { onDelete: "set null" }
    ),

    templateId: integer("template_id")
      .references(() => idCardTemplatesSchema.id, { onDelete: "set null" })
      .notNull(),

    /** Human-readable printed ID, e.g. "EDX-2026-000123". Unique per school. */
    cardNumber: text("card_number").notNull(),

    /**
     * Opaque, unguessable token embedded in the QR code as part of the
     * verification URL: https://<frontend>/verify/{verificationToken}
     * Long-lived (does not expire with the card's validUntil) so that the
     * PUBLIC verify endpoint can still resolve the card and report its
     * CURRENT status (active/revoked/expired) even after validUntil has
     * passed — this is what lets staff scan an old card and be told
     * "expired" rather than getting a dead link.
     */
    verificationToken: text("verification_token").notNull(),

    // ── SNAPSHOT FIELDS (frozen at issue time) ────────────────────────────────
    // A card, once printed, is a physical object. If the holder's name,
    // photo, or role changes later in the system, the PRINTED card and its
    // QR-verify page must keep matching each other until the card is
    // reissued. Mirrors the createdByName snapshot pattern in feed_posts.
    holderNameSnapshot: text("holder_name_snapshot").notNull(),
    photoUrlSnapshot: text("photo_url_snapshot"),
    /**
     * JSON snapshot of the role-specific display fields shown on the card
     * at issue time (className/sectionName/rollNumber/admissionNumber for
     * students; designation/department/employeeCode for staff; bloodGroup
     * for both). Keeps the printed card stable; the live admin view can
     * still show "current" values separately by joining fresh data if ever
     * needed, but the verify endpoint always serves this frozen snapshot.
     */
    detailsSnapshot: text("details_snapshot").notNull().default("{}"),

    issuedAt: text("issued_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    /** Typically end of the current academic year for students; a school
     *  configurable validity window (e.g. 1–3 years) for staff. */
    validUntil: text("valid_until").notNull(),

    status: text("status")
      .$type<IdCardStatusValue>()
      .notNull()
      .default("ACTIVE"),

    issuedBy: integer("issued_by")
      .references(() => schoolUsersSchema.id)
      .notNull(),

    revokedAt: text("revoked_at"),
    revokedBy: integer("revoked_by").references(() => schoolUsersSchema.id),
    revokedReason: text("revoked_reason"),

    /**
     * Self-referencing pointer set on the OLD row when a reissue happens,
     * pointing to the NEW row's id. Lets the admin UI show "Reissued as
     * card #EDX-2026-000456" instead of just a dead REISSUED status.
     */
    reissuedAsCardId: integer("reissued_as_card_id"),

    createdAt: text("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    uniqueCardNumberPerSchool: uniqueIndex("uq_id_card_number_per_school").on(
      table.schoolId,
      table.cardNumber
    ),
    // Public verify endpoint looks up by token on every scan — must be fast,
    // and uniqueness here is a hard security requirement (collision would
    // let one card's QR resolve to another holder's data).
    uniqueVerificationToken: uniqueIndex("uq_id_card_verification_token").on(
      table.verificationToken
    ),
    // Admin list/filter screen: "all cards for this holder", "all active
    // student cards", etc.
    holderIdx: index("idx_id_cards_holder").on(
      table.holderUserId,
      table.status
    ),
    holderTypeStatusIdx: index("idx_id_cards_type_status").on(
      table.schoolId,
      table.holderType,
      table.status
    ),
  })
);

export type IdCard = typeof idCardsSchema.$inferSelect;
export type NewIdCard = typeof idCardsSchema.$inferInsert;
