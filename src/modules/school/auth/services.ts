import { eq } from "drizzle-orm";
import { schoolRefreshTokensSchema } from "../../../db/schemas/school/refresh-tokens";
import { generateSchoolAccessToken, generateSchoolRefreshToken as generateSchoolRefreshTokenUtil } from "../../../utils/school/tokens";

export async function generateSchoolTokens(
  db: any,
  user: { id: number; name: string; role: string; schoolCode: string },
  secret: string
) {
  // 1. Delete ALL old refresh tokens for this user (single session policy)
  await db.delete(schoolRefreshTokensSchema).where(eq(schoolRefreshTokensSchema.userId, user.id));

  // 2. Generate new tokens
  const access_token = await generateSchoolAccessToken(user, secret); // 1 hour
  const refresh_token = await generateSchoolRefreshTokenUtil(db, user.id); // 30 days

  return { access_token, refresh_token };
}