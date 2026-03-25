import { Bindings } from "hono/types";
import { SchoolRole } from "./school-role";


export type SchoolUserContext = {
  id: number;
  role: SchoolRole;
  schoolCode: string;
};

export type Env = {
  Bindings: Bindings & {
    JWT_SECRET: string;
    COMMON_TURSO_DATABASE_URL: string;
    COMMON_TURSO_AUTH_TOKEN: string;
    SCHOOL_TURSO_DATABASE_URL: string;
    SCHOOL_TURSO_AUTH_TOKEN: string;
    APP_URL: string;
    BREVO_API_KEY: string;
    BREVO_SENDER_EMAIL: string;
    BREVO_SENDER_NAME: string;
  };
};

// New: School-specific environment with custom context variables
export type SchoolEnv = {
  Bindings: Env['Bindings'];
  Variables: {
    jwtPayload?: any;
    user?: SchoolUserContext;      // ← For school user
    schoolCode?: string;           // ← For easy access
  };
};
