import { eq } from "drizzle-orm";
import { sign } from "hono/jwt";
import { refreshTokensSchema } from "../../db/schemas/super/refresh-tokens";
import { SuperPermissionSlugWithWildcard } from "../../types/super-permissions";

const ACCESS_TOKEN_TTL = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days

/** Generates a short-lived access token with permissions embedded. */
export async function generateSuperAccessToken(
  user: {
    id: number;
    name: string;
    permissions: SuperPermissionSlugWithWildcard[];
    tokenVersion: number;
  },
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: String(user.id),
      name: user.name,
      permissions: user.permissions,
      tokenVersion: user.tokenVersion,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL,
    },
    secret,
    "HS256"
  );
}

/** Stores a refresh token and returns its raw value. */
export async function generateSuperRefreshToken(
  db: any,
  userId: number
): Promise<string> {
  // Rotate: delete all existing refresh tokens for this user
  await db
    .delete(refreshTokensSchema)
    .where(eq(refreshTokensSchema.userId, userId));

  const token = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL;

  await db.insert(refreshTokensSchema).values({ userId, token, expiresAt });
  return token;
}

/** Validates a refresh token and returns its DB record (or null). */
export async function validateSuperRefreshToken(
  db: any,
  token: string
): Promise<{ userId: number } | null> {
  const record = await db
    .select()
    .from(refreshTokensSchema)
    .where(eq(refreshTokensSchema.token, token))
    .get();

  if (!record) return null;
  if (record.expiresAt < Math.floor(Date.now() / 1000)) {
    // Expired — clean up
    await db
      .delete(refreshTokensSchema)
      .where(eq(refreshTokensSchema.token, token));
    return null;
  }

  return { userId: record.userId };
}
