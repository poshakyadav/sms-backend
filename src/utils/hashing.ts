// src/utils/hashing.ts

import bcrypt from "bcryptjs";

// ─────────────────────────────────────────────────────────────────────────────
// PBKDF2 CONSTANTS
// Cloudflare Workers hard-caps PBKDF2 at 100,000 iterations (workerd limit).
// SHA-256 at 100k is the correct choice for this runtime.
// ─────────────────────────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEY_BITS = 256;
const PBKDF2_PREFIX = "pbkdf2:";

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function buf2b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b642buf(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hashPBKDF2(password: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const salt = crypto.getRandomValues(
    new Uint8Array(16)
  ) as Uint8Array<ArrayBuffer>;
  const hashBuf = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    PBKDF2_KEY_BITS
  );
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}:${buf2b64(
    salt.buffer
  )}:${buf2b64(hashBuf)}`;
}

async function comparePBKDF2(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4) return false;

  const [, iterStr, b64Salt, b64Hash] = parts;
  const iterations = parseInt(iterStr, 10);
  if (isNaN(iterations) || iterations < 1) return false;

  const salt = b642buf(b64Salt) as Uint8Array<ArrayBuffer>;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    PBKDF2_KEY_BITS
  );
  return buf2b64(hashBuf) === b64Hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash a password using PBKDF2-SHA256 (native C++ on Cloudflare Workers).
 *
 * Used by ALL write paths: login/signup, create user, bulk upload.
 * bcrypt is no longer used for hashing — only for verifying old stored hashes.
 *
 * ~5–10 ms per call on Workers. Genuinely parallel with Promise.all().
 */
export async function hashPassword(password: string): Promise<string> {
  return hashPBKDF2(password);
}

/**
 * Same as hashPassword — exported separately so bulk-upload can import it
 * by its explicit name without any behavioural difference.
 */
export async function hashPasswordFast(password: string): Promise<string> {
  return hashPBKDF2(password);
}

/**
 * Compare a password against a stored hash.
 *
 * AUTO-DETECTS format:
 *   "pbkdf2:..." → PBKDF2 path (all new hashes)
 *   "$2b$..."    → bcrypt path (legacy hashes only — read-only backward compat)
 *   anything else → false (fail closed)
 *
 * The bcrypt branch is NEVER called for new users going forward.
 * It exists purely so existing users with bcrypt hashes can still log in.
 * Once all users have logged in at least once and their hashes are
 * re-written to PBKDF2 (via upgradeHashIfNeeded), bcryptjs can be removed.
 */
export async function comparePassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  if (!storedHash) return false;

  if (storedHash.startsWith(PBKDF2_PREFIX)) {
    return comparePBKDF2(password, storedHash);
  }

  if (storedHash.startsWith("$2b$") || storedHash.startsWith("$2a$")) {
    return bcrypt.compare(password, storedHash);
  }

  // Unknown format — fail closed
  console.warn(
    "[hashing] Unknown password hash format:",
    storedHash.slice(0, 10)
  );
  return false;
}

/**
 * OPTIONAL: Re-hash a bcrypt hash to PBKDF2 on successful login.
 *
 * Call this after a successful comparePassword() in your login route.
 * Returns the new PBKDF2 hash string if the stored hash was bcrypt,
 * or null if it was already PBKDF2 (no upgrade needed).
 *
 * Usage in auth/routes.ts login handler:
 *
 *   const isValid = await comparePassword(password, user.passwordHash);
 *   if (!isValid) return c.json({ error: "Invalid credentials" }, 401);
 *
 *   // Silently upgrade bcrypt → PBKDF2 on successful login
 *   const newHash = await upgradeHashIfNeeded(password, user.passwordHash);
 *   if (newHash) {
 *     db.update(schoolUsersSchema)
 *       .set({ passwordHash: newHash })
 *       .where(eq(schoolUsersSchema.id, user.id))
 *       .catch(console.error); // fire-and-forget, never block login
 *   }
 *
 * Once every user's hash starts with "pbkdf2:", you can:
 *   1. Delete the upgradeHashIfNeeded call
 *   2. Delete the bcrypt branch in comparePassword
 *   3. Remove bcryptjs from package.json
 */
export async function upgradeHashIfNeeded(
  password: string,
  storedHash: string
): Promise<string | null> {
  if (storedHash.startsWith(PBKDF2_PREFIX)) {
    return null; // Already PBKDF2
  }
  return hashPBKDF2(password); // Was bcrypt — upgrade
}
