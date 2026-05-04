import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schemas/super/*.ts',
  out: './drizzle',
  dialect: 'turso',  // Always Turso – auto-uses @libsql/client
  dbCredentials: {
    url: process.env.COMMON_TURSO_DATABASE_URL!,
    authToken: process.env.COMMON_TURSO_AUTH_TOKEN!,
  },
});