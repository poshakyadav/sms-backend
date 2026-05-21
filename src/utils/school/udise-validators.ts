// src/utils/school/udise-validators.ts

/**
 * PEN Validation
 * 16-digit numeric string. No checksum algorithm is publicly documented
 * by MoE, so we validate format only.
 */
export function isValidPEN(pen: string): boolean {
  return /^\d{16}$/.test(pen.trim());
}

/**
 * APAAR ID Validation
 * 12-digit numeric string (same format as Aadhaar structurally,
 * but a completely different system).
 */
export function isValidAPAAR(apaarId: string): boolean {
  return /^\d{12}$/.test(apaarId.trim());
}

/**
 * UDISE School Code Validation
 * 11-digit: 2 (state) + 2 (district) + 2 (block) + 3 (cluster) + 2 (school)
 */
export function isValidUDISECode(code: string): boolean {
  return /^\d{11}$/.test(code.trim());
}

/**
 * Mask Aadhaar — only store last 4 digits
 */
export function maskAadhaar(aadhaar: string): string {
  const digits = aadhaar.replace(/\D/g, "");
  if (digits.length !== 12) throw new Error("Invalid Aadhaar number");
  return `XXXX XXXX ${digits.slice(8)}`;
}
