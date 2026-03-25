import { sign } from "hono/jwt";
import { nanoid } from "nanoid";
import { schoolRefreshTokensSchema } from "../../db/schemas/school";
import { eq } from "drizzle-orm";

/**
 * PRODUCTION-GRADE TOKEN UTILITIES
 *
 * Access Token  → 1 hour  (short-lived, high security)
 * Refresh Token → 30 days (long-lived, single session per user)
 *
 * All tokens are signed with the school's JWT_SECRET from env.
 * Refresh tokens are stored in DB with expiration for revocation support.
 */

const ACCESS_TOKEN_EXPIRY = 60 * 60; // 1 hour  (If want to test then use 60 * 15 for 15 minutes)
const REFRESH_TOKEN_EXPIRY = 60 * 60 * 24 * 30; // 30 days

/**
 * Generate Access Token (short-lived)
 * Used for all authenticated requests
 */
export async function generateSchoolAccessToken(
  user: { id: number; name: string; role: string; schoolCode: string },
  secret: string
): Promise<string> {
  const payload = {
    sub: user.id.toString(),
    name: user.name,
    role: user.role,
    schoolCode: user.schoolCode,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRY,
  };

  return await sign(payload, secret);
}

/**
 * Generate Refresh Token + Store in DB
 * Single active refresh token per user (old one is deleted on new login/refresh)
 */
export async function generateSchoolRefreshToken(
  db: any,
  userId: number
): Promise<string> {
  const token = nanoid(32); // Secure random token

  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY;

  // Delete any old refresh token for this user (single session policy)
  await db
    .delete(schoolRefreshTokensSchema)
    .where(eq(schoolRefreshTokensSchema.userId, userId));

  // Insert new refresh token
  await db
    .insert(schoolRefreshTokensSchema)
    .values({ userId, token, expiresAt });

  return token;
}

/**
 * Validate Refresh Token
 * Returns userId if valid, null if expired or invalid
 */
export async function validateSchoolRefreshToken(
  db: any,
  token: string
): Promise<{ userId: number } | null> {
  const entry = await db
    .select()
    .from(schoolRefreshTokensSchema)
    .where(eq(schoolRefreshTokensSchema.token, token))
    .get();

  if (!entry || entry.expiresAt < Math.floor(Date.now() / 1000)) {
    return null; // Token expired or not found
  }

  return { userId: entry.userId };
}
