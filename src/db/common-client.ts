import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schemas/super";
import type { Env } from "../types/common-types";

export const getCommonDB = (env: Env['Bindings']) => {
  const url = env.COMMON_TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Missing or invalid COMMON_TURSO_DATABASE_URL");
  }

  const authToken = env.COMMON_TURSO_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error("Missing or invalid COMMON_TURSO_AUTH_TOKEN");
  }

  const client = createClient({ url, authToken });
  return drizzle(client, { schema });
};