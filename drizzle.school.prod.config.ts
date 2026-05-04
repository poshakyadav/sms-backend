import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schemas/school/*.ts", // Only school schemas
  out: "./school-migrations-prod", // Dedicated folder
  dialect: "turso",
  dbCredentials: {
    url: process.env.SCHOOL_TURSO_DATABASE_URL!, // Dummy for generation; we don't push here
    authToken: process.env.SCHOOL_TURSO_AUTH_TOKEN!,
  },
});
