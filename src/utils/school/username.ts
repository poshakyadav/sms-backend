// src/utils/school/username.ts

/**
 * USERNAME RULES
 *   - lowercase a-z and 0-9 only
 *   - MUST start with a letter (never a digit)
 *   - 3-30 characters total
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_REGEX = /^[a-z][a-z0-9]{2,29}$/;

export function isValidUsernameFormat(username: string): boolean {
    return USERNAME_REGEX.test(username);
}

/** Trim + lowercase only — we do NOT silently strip invalid characters.
 *  If the input still fails isValidUsernameFormat() after this, the caller
 *  should reject it with a clear message rather than mangling it. */
export function normalizeUsername(raw: string): string {
    return raw.trim().toLowerCase();
}

const BASE36_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars

/**
 * Cryptographically-sourced random suffix using the Workers-native Web
 * Crypto API (crypto.getRandomValues) — zero DB/network round trips,
 * sub-millisecond CPU cost, safe under concurrent invocations (each
 * request gets its own random bytes; nothing shared to race on).
 *
 * Uses rejection sampling to avoid modulo bias: 256 isn't a multiple of
 * 36 (256 = 7*36 + 4), so a naive `byte % 36` would slightly favour the
 * first four letters of the alphabet. We discard bytes >= 252 (7*36) and
 * resample — this discards <2% of bytes, unmeasurable in CPU time.
 */
export function randomUsernameSuffix(length: number): string {
    const REJECTION_CEILING = 252; // largest multiple of 36 that fits a byte
    let out = "";
    const buf = new Uint8Array(length * 2); // over-request so we rarely loop twice

    while (out.length < length) {
        crypto.getRandomValues(buf);
        for (let i = 0; i < buf.length && out.length < length; i++) {
            const b = buf[i];
            if (b < REJECTION_CEILING) {
                out += BASE36_ALPHABET[b % 36];
            }
        }
    }
    return out;
}

/**
 * Builds a valid username "base" from a display name, e.g.
 * "Aarav Sharma" -> "aaravsharma". Strips accents/diacritics, drops any
 * leading digits (they'd violate the "must start with a letter" rule),
 * and falls back to "user" if nothing usable remains (e.g. a name that's
 * entirely non-Latin script, until you add transliteration).
 * Truncated to leave headroom for a random suffix under the 30-char cap.
 */
export function buildUsernameBase(displayName: string, maxLength = 16): string {
    let base = displayName
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "") // strip accents: é -> e
        .replace(/[^a-z0-9]/g, "")
        .replace(/^[0-9]+/, ""); // must not start with a digit

    if (base.length === 0) base = "user";
    return base.slice(0, maxLength);
}

/**
 * Builds the Nth candidate username for a given base. Always appends a
 * random suffix (never tries the bare base) — this is deliberate: it lets
 * createSchoolUser() skip a pre-check SELECT entirely and go straight to
 * INSERT, since the suffix space (36^4 ≈ 1.68M combos, growing to 36^6 on
 * later attempts) makes a collision vanishingly unlikely even under
 * concurrent signups sharing the same base name.
 */
export function buildUsernameCandidate(base: string, attempt: number): string {
    const suffixLength = attempt < 3 ? 4 : 6;
    const candidate = `${base}${randomUsernameSuffix(suffixLength)}`;
    return candidate.slice(0, USERNAME_MAX_LENGTH);
}