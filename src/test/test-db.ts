import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schoolSchema from "../db/schemas/school/index.js";
import type { Env } from "../types/common-types";

export const getTestDB = (env: Env["Bindings"]) => {
  const url = env.TEST_TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Missing TEST_TURSO_DATABASE_URL in .dev.vars");
  }

  const authToken = env.TEST_TURSO_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error("Missing TEST_TURSO_AUTH_TOKEN in .dev.vars");
  }

  const client = createClient({ url, authToken });
  return drizzle(client, { schema: schoolSchema });
};
