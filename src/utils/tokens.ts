import { sign, verify } from 'hono/jwt';
import { nanoid } from 'nanoid';
import { refreshTokensSchema } from '../db/schemas/super/refresh-tokens';
import { eq } from 'drizzle-orm';

export async function generateAccessToken(user: { id: number; name: string; role: string }, secret: string) {
  const payload = {
    sub: user.id.toString(),
    name: user.name,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 60 * 15,  // 15 min
  };
  return await sign(payload, secret);
}

export async function generateRefreshToken(db: any, userId: number) {
  const token = nanoid(32);
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;  // 7 days
  await db.insert(refreshTokensSchema).values({ userId, token, expiresAt });
  return token;
}

export async function validateRefreshToken(db: any, token: string): Promise<{ userId: number } | null> {
  const entry = await db.select().from(refreshTokensSchema).where(eq(refreshTokensSchema.token, token)).get();
  if (!entry || entry.expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return { userId: entry.userId };
}