import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schemas/school/*.ts",
  out: "./school-migrations-dev",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TEST_TURSO_DATABASE_URL!,
    authToken: process.env.TEST_TURSO_AUTH_TOKEN!,
  },
});
