import { and, eq } from "drizzle-orm";
import { schoolRefreshTokensSchema } from "../../../db/schemas/school/refresh-tokens";
import {
  generateSchoolAccessToken,
  generateSchoolRefreshToken as generateSchoolRefreshTokenUtil,
} from "../../../utils/school/tokens";
import {
  schoolsSchema,
  schoolThemeConfigsSchema,
} from "../../../db/schemas/school";
import { getUserPermissionsFromDB } from "./permission-helpers";


/**
 * PRODUCTION-GRADE TOKEN GENERATOR
 * 
 * Generates both access + refresh tokens with real permissions from DB.
 * Automatically fetches permissions if not provided.
 * 
 * @param db - Drizzle database instance
 * @param user - User data (can omit permissions, will be fetched)
 * @param secret - JWT secret
 * @returns Access token + refresh token
 */

export async function generateSchoolTokens(
  db: any,
  user: {
    id: number;
    name: string;
    email?: string;
    schoolCode: string;
    permissions: string[]; 
    tokenVersion: number; 
    role?: string;
  },
  secret: string
) {

  // 1. Fetch permissions from DB if not provided
  let permissions = user.permissions;
  
  if (!permissions || permissions.length === 0) {
    console.log(`🔍 Fetching permissions for user ${user.id} from DB...`);
    permissions = await getUserPermissionsFromDB(db, user.id);
  }

  // 2. Generate tokens with full permissions
  const access_token = await generateSchoolAccessToken(
    {
      id: user.id,
      name: user.name,
      email: user.email ?? "",
      schoolCode: user.schoolCode,
      permissions: permissions as string[],
      tokenVersion: user.tokenVersion,
      role: user.role ?? '',
    },
    secret
  );
  
  const refresh_token = await generateSchoolRefreshTokenUtil(db, user.id);

  return { access_token, refresh_token };
}

export async function validateSchoolCode(
  db: any,
  schoolCode: string
): Promise<{
  valid: boolean;
  school?: {
    id: number;
    name: string;
    uniqueCode: string;
    isActive: boolean;
    logoUrl: string | null;
    tagline: string | null;
    theme?: {
      themeName: string;
      config: any; // JSON object with all CSS variables
      isCustomTheme: boolean;
    };
  };
  error?: string;
  statusCode?: number;
}> {
  try {
    // Format validation
    const formattedCode = schoolCode.trim().toUpperCase();

    if (!formattedCode || formattedCode.length < 3) {
      return {
        valid: false,
        error: "School code must be at least 3 characters long",
        statusCode: 400,
      };
    }

    if (!/^[A-Z0-9-]+$/.test(formattedCode)) {
      return {
        valid: false,
        error:
          "School code can only contain uppercase letters, numbers, and hyphens",
        statusCode: 400,
      };
    }

    // Get database connection for this school
    const schoolRecord = await db
      .select({
        id: schoolsSchema.id,
        name: schoolsSchema.name,
        uniqueCode: schoolsSchema.uniqueCode,
        isActive: schoolsSchema.isActive,
        logoUrl: schoolsSchema.logoUrl,
        tagline: schoolsSchema.tagline,

        // Theme data
        themeName: schoolThemeConfigsSchema.themeName,
        themeConfig: schoolThemeConfigsSchema.config,
        isCustomTheme: schoolThemeConfigsSchema.isCustomTheme,
      })
      .from(schoolsSchema)
      .leftJoin(
        schoolThemeConfigsSchema,
        and(
          eq(schoolThemeConfigsSchema.schoolId, schoolsSchema.id),
          eq(schoolThemeConfigsSchema.isActive, true)
        )
      )
      .where(eq(schoolsSchema.uniqueCode, formattedCode))
      .get();

    if (!schoolRecord) {
      return {
        valid: false,
        error: "School code not found. Please check the code and try again.",
        statusCode: 404,
      };
    }

    if (!schoolRecord.isActive) {
      return {
        valid: false,
        error:
          "This school account has been deactivated. Please contact support.",
        statusCode: 403,
      };
    }

    return {
      valid: true,
      school: {
        id: schoolRecord.id,
        name: schoolRecord.name,
        uniqueCode: schoolRecord.uniqueCode,
        isActive: schoolRecord.isActive,
        logoUrl: schoolRecord.logoUrl,
        tagline: schoolRecord.tagline,
        theme: schoolRecord.themeName
          ? {
              themeName: schoolRecord.themeName,
              config: JSON.parse(schoolRecord.themeConfig || "{}"),
              isCustomTheme: schoolRecord.isCustomTheme,
            }
          : undefined,
      },
    };
  } catch (error: any) {
    console.error("School code validation error:", error);
    return {
      valid: false,
      error:
        "Unable to validate school code at this time. Please try again later.",
      statusCode: 500,
    };
  }
}
