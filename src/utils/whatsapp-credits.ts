// src/utils/whatsapp-credits.ts
//
// Credit accounting utilities used by both single-send and bulk-send services.
// All credit operations go through these functions — never update balance tables directly.
//
// CREDIT MODEL (prepaid + optimistic):
//   Deduct BEFORE calling Meta → prevents race conditions on concurrent bulk sends.
//   On Meta hard errors → credits remain deducted (API attempt consumed a slot).
//   On transient failures (timeout, 5xx) → retry; credit was deducted on first try.
//   We do NOT refund failed sends — this is standard prepaid messaging behavior.

import { eq, sql } from "drizzle-orm";

// ── Deduct credits ────────────────────────────────────────────────────────────

/**
 * Deducts `count` credits from the school's WhatsApp balance.
 * Throws with a clear message if balance is insufficient.
 * Must be called INSIDE a transaction when combined with inserts.
 *
 * @param schoolDb  School's Turso DB drizzle instance
 * @param count     Number of credits to deduct (1 per message)
 * @param whatsappBalanceSchema  Imported schema (avoid circular imports)
 */
export async function deductWhatsappCredits(
  schoolDb: any,
  count: number,
  whatsappBalanceSchema: any
): Promise<{ creditsRemaining: number }> {
  const balance = await schoolDb
    .select()
    .from(whatsappBalanceSchema)
    .where(eq(whatsappBalanceSchema.id, 1))
    .get();

  if (!balance) {
    throw new Error(
      "No WhatsApp credit balance found. Please purchase a bundle first."
    );
  }

  if (balance.creditsRemaining < count) {
    throw new Error(
      `Insufficient WhatsApp credits. You have ${
        balance.creditsRemaining
      } credit${
        balance.creditsRemaining === 1 ? "" : "s"
      } remaining but need ${count}. Please purchase more credits.`
    );
  }

  await schoolDb
    .update(whatsappBalanceSchema)
    .set({
      creditsUsed: balance.creditsUsed + count,
      creditsRemaining: balance.creditsRemaining - count,
      lastUpdated: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(whatsappBalanceSchema.id, 1));

  return { creditsRemaining: balance.creditsRemaining - count };
}

/**
 * Returns the current balance without modifying it.
 * Returns zero balance object if no row exists yet (before first bundle purchase).
 */
export async function getWhatsappBalance(
  schoolDb: any,
  whatsappBalanceSchema: any
): Promise<{
  totalCreditsEverPurchased: number;
  creditsUsed: number;
  creditsRemaining: number;
  lastPurchaseAt: string | null;
}> {
  const balance = await schoolDb
    .select()
    .from(whatsappBalanceSchema)
    .where(eq(whatsappBalanceSchema.id, 1))
    .get();

  return (
    balance ?? {
      totalCreditsEverPurchased: 0,
      creditsUsed: 0,
      creditsRemaining: 0,
      lastPurchaseAt: null,
    }
  );
}

// ── Phone number normalisation ─────────────────────────────────────────────────

/**
 * Normalises a phone number to Meta's expected format:
 * E.164 WITHOUT the leading + sign.
 *
 * Examples:
 *   "+91 98765 43210" → "919876543210"
 *   "0091-9876543210" → "919876543210"
 *   "9876543210"      → "919876543210"  (assumes India when no country code)
 *   "+1 555 658 1623" → "15556581623"
 *
 * Meta recommends always including the country code. We default to India (+91)
 * only when the number is exactly 10 digits (Indian mobile number format).
 */
export function normalisePhone(raw: string): string {
  // Strip all non-digit characters
  const digits = raw.replace(/\D/g, "");

  // If starts with 00 (international prefix), strip it
  const stripped = digits.startsWith("00") ? digits.slice(2) : digits;

  // Detect Indian 10-digit mobile (starts with 6, 7, 8, or 9)
  if (stripped.length === 10 && /^[6-9]/.test(stripped)) {
    return `91${stripped}`;
  }

  // Already has country code (11+ digits)
  if (stripped.length >= 11) {
    return stripped;
  }

  return stripped;
}

/**
 * Validates that a normalised phone number is plausibly correct.
 * Does NOT make any API call — just format-checks.
 */
export function isValidPhone(normalised: string): boolean {
  // Must be 10–15 digits (ITU-T E.164 max is 15 digits without +)
  return /^\d{10,15}$/.test(normalised);
}

// ── Template variable builder ─────────────────────────────────────────────────

/**
 * Converts a named-variable map into an ordered array of strings
 * matching the template's {{1}} {{2}} ... placeholder positions.
 *
 * @param variableNames  Ordered list from PLATFORM_TEMPLATES[key].variables
 *                       e.g. ["parent_name","student_name","date","status","school_name"]
 * @param values         Map of name → actual value
 *                       e.g. { parent_name: "Mr. Sharma", student_name: "Rohan", ... }
 * @returns              Ordered string array suitable for WhatsappService.sendTemplate()
 *
 * Throws if any variable is missing from `values`.
 */
export function buildBodyParameters(
  variableNames: readonly string[],
  values: Record<string, string>
): string[] {
  // Only validate variables that belong to THIS template's variable list.
  // Reject only truly missing keys (undefined/null), not empty strings —
  // unused slots in makeAnnouncementVars are intentionally set to "".
  const missing = variableNames.filter(
    (name) => values[name] === undefined || values[name] === null
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required template variables: ${missing.join(", ")}`
    );
  }
  return variableNames.map((name) => String(values[name] ?? "").trim());
}
