import { createClient, Client } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schemas/super";
import type { Env } from "../types/common-types";

// Module-level cache — survives across requests in the same worker isolate
let cachedCommonClient: Client | null = null;
let cachedCommonUrl: string | null = null;

export const getCommonDB = (env: Env["Bindings"]) => {
  const url = env.COMMON_TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error("Missing or invalid COMMON_TURSO_DATABASE_URL");

  const authToken = env.COMMON_TURSO_AUTH_TOKEN?.trim();
  if (!authToken) throw new Error("Missing or invalid COMMON_TURSO_AUTH_TOKEN");

  // Reuse the client if the URL hasn't changed
  if (cachedCommonClient && cachedCommonUrl === url) {
    return drizzle(cachedCommonClient, { schema });
  }

  cachedCommonClient = createClient({ url, authToken });
  cachedCommonUrl = url;
  return drizzle(cachedCommonClient, { schema });
};
