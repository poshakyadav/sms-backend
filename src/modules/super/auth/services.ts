// src/modules/auth/services.ts
import { and, eq } from "drizzle-orm";
import { superUsersSchema } from "../../../db/schemas/super/super-users";
import { userPermissionsSchema } from "../../../db/schemas/super/user-permissions";
import { refreshTokensSchema } from "../../../db";
import { hashPassword, comparePassword } from "../../../utils/hashing";
import { generateAccessToken, generateRefreshToken } from "../../../utils/tokens";
import { defaultPermissions } from "../../../types/permissions";
import { SuperRole } from "../../../types/super-role";
import { Permission } from "../../../types/permissions";

export async function registerUser(
  db: any,
  data: { name: string; email: string; password: string; role?: SuperRole }
) {
  const { name, email, password, role = SuperRole.SUPERUSER } = data;
  const existing = await db
    .select()
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, email))
    .get();
  if (existing) throw new Error("Email taken");

  const passwordHash = await hashPassword(password);
  const [newUser] = await db
    .insert(superUsersSchema)
    .values({ name, email, passwordHash, role })
    .returning();

  // Assign default permissions
  const defaults = defaultPermissions[role];
  const permInserts = Object.entries(defaults).map(([permission, allowed]) => ({
    userId: newUser.id,
    permission: permission as Permission,
    allowed,
  }));
  if (permInserts.length)
    await db.insert(userPermissionsSchema).values(permInserts);

  return newUser;
}

export async function loginUser(db: any, email: string, password: string) {
  const user = await db
    .select()
    .from(superUsersSchema)
    .where(eq(superUsersSchema.email, email))
    .get();
  if (!user || !(await comparePassword(password, user.passwordHash)))
    throw new Error("Invalid credentials");
  return user;
}

export async function refreshAccessToken(
  db: any,
  refreshToken: string,
  secret: string
) {
  const tokenEntry = await db
    .select()
    .from(refreshTokensSchema)
    .where(eq(refreshTokensSchema.token, refreshToken))
    .get();

  // FIXED: Compare seconds to seconds
  const currentTimeSeconds = Math.floor(Date.now() / 1000);
  if (!tokenEntry || tokenEntry.expiresAt < currentTimeSeconds) {
    throw new Error("Invalid or expired refresh token");
  }

  const user = await db
    .select()
    .from(superUsersSchema)
    .where(eq(superUsersSchema.id, tokenEntry.userId))
    .get();
  if (!user) throw new Error("User not found");

  // Optional rotation: Delete old token, generate new refresh
  await db
    .delete(refreshTokensSchema)
    .where(eq(refreshTokensSchema.token, refreshToken));
  const newRefreshToken = await generateRefreshToken(db, user.id); // From utils

  const access_token = await generateAccessToken(user, secret);

  // Return NEW refresh token
  return { access_token, refresh_token: newRefreshToken, user };
}

export async function logoutUser(
  db: any,
  refreshToken: string,
  userIdFromToken?: number
) {
  // Build conditions array (always at least one condition)
  const conditions = [eq(refreshTokensSchema.token, refreshToken)];

  // Add user ownership check only if userId is provided
  if (userIdFromToken !== undefined) {
    conditions.push(eq(refreshTokensSchema.userId, userIdFromToken));
  }

  // Combine all conditions safely
  const whereClause = and(...conditions)!; // ! is safe because we always have at least 1 condition

  // Check if token exists (and matches user if provided)
  const entry = await db
    .select()
    .from(refreshTokensSchema)
    .where(whereClause)
    .get();

  if (!entry) {
    throw new Error("Refresh token not found or already logged out");
  }

  // Delete the token
  await db.delete(refreshTokensSchema).where(whereClause);
}

export async function generateTokens(
  db: any,
  user: { id: number; name: string; role: string },
  secret: string
) {
  // Optional: Delete ALL old refresh tokens for this user on new login (single-session enforcement)
  // Comment out if you want multi-device support (allow multiple active tokens)
  await db
    .delete(refreshTokensSchema)
    .where(eq(refreshTokensSchema.userId, user.id));

  const access_token = await generateAccessToken(user, secret);
  const refresh_token = await generateRefreshToken(db, user.id);
  return { access_token, refresh_token };
}
