import { Bindings } from "hono/types";
import { SchoolRole } from "./school-role";



export type SuperUserContext = {
  id: number;
  name: string;
  permissions: string[];   // SuperPermissionSlugWithWildcard[] at runtime
  tokenVersion: number;
};

export type SchoolUserContext = {
  id: number;
  name: string;
  email: string;  
  schoolCode: string;
  permissions: string[];           // ← Full permissions from JWT
  tokenVersion: number;            // ← For instant invalidation
   /** Role name embedded in JWT by generateSchoolTokens (e.g. "TEACHER", "STUDENT_PARENT") */
   role?: string;
};

export type Env = {
  Bindings: Bindings & {
    JWT_SECRET: string;
    COMMON_TURSO_DATABASE_URL: string;
    COMMON_TURSO_AUTH_TOKEN: string;
    SCHOOL_TURSO_DATABASE_URL: string;
    SCHOOL_TURSO_AUTH_TOKEN: string;
    // ====
    // Test Turso Database URL and Auth Token
    TEST_TURSO_DATABASE_URL: string;
    TEST_TURSO_AUTH_TOKEN: string;
    // ====
    APP_URL: string;
    BREVO_API_KEY: string;
    BREVO_SENDER_EMAIL: string;
    BREVO_SENDER_NAME: string;
  };
  Variables: {
    jwtPayload?: any;
    superUser?: SuperUserContext;   // ← set by superTokenValidationMiddleware
  };
};

// School-specific environment with custom context variables
export type SchoolEnv = {
  Bindings: Env['Bindings'];
  Variables: {
    jwtPayload?: any;
    user?: SchoolUserContext;      // ← For school user
    schoolCode?: string;           // ← For easy access
  };
};
