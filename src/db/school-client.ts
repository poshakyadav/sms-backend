// src/db/school-client.ts
//
// OPTIMISED: Check in-process Map BEFORE hitting common DB.
//
// Check the Map first. If hit → return immediately, zero DB calls.
// If miss → query common DB, create client, cache it.
//
// This is the single most impactful change for the cold-start problem.
// On a warm isolate (most requests after the first), getSchoolDB now
// costs zero network calls.

import { createClient, Client } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schoolSchema from "./schemas/school";
import { schoolsSchema, tursoDatabasesSchema } from "./schemas/super";
import { eq } from "drizzle-orm";
import type { Env } from "../types/common-types";
import { getCommonDB } from "./common-client";

// Per-school client cache: schoolCode → { client, url }
// Module-level — survives across requests in the same worker isolate.
// Cloudflare Workers reuse isolates across requests, so this cache
// remains populated for the lifetime of the isolate (minutes to hours).
const schoolClientCache = new Map<string, { client: Client; url: string }>();

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 100
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      const isTransient =
        err?.cause?.remote === true ||
        err?.message?.includes("internal error") ||
        err?.message?.includes("SQLITE_BUSY") ||
        err?.message?.includes("network") ||
        err?.message?.includes("timeout");

      if (!isTransient || i === attempts - 1) throw err;

      // Clear the specific cached client that failed so we get a fresh
      // connection on the next attempt
      for (const [key, val] of schoolClientCache.entries()) {
        if (val.url === (err?.url ?? "")) {
          schoolClientCache.delete(key);
          break;
        }
      }

      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }

  throw lastError;
}

export const getSchoolDB = async (env: Env["Bindings"], uniqueCode: string) => {
  // ── Fast path: in-process Map hit — ZERO network calls ─────────────────
  // Check the cache BEFORE touching the common DB. The original code
  // always queried common DB first, wasting a round trip on warm isolates.
  const cached = schoolClientCache.get(uniqueCode);
  if (cached) {
    return drizzle(cached.client, { schema: schoolSchema });
  }

  // ── Cold path: isolate restarted or first request for this school ───────
  // Only reaches here once per school per isolate lifetime.
  const commonDB = getCommonDB(env);

  const school = await withRetry(() =>
    commonDB
      .select({
        url: tursoDatabasesSchema.url,
        authToken: tursoDatabasesSchema.authToken,
      })
      .from(schoolsSchema)
      .innerJoin(
        tursoDatabasesSchema,
        eq(schoolsSchema.tursoDbId, tursoDatabasesSchema.id)
      )
      .where(eq(schoolsSchema.uniqueCode, uniqueCode))
      .get()
  );

  if (!school) throw new Error("School not found");

  const client = createClient({ url: school.url, authToken: school.authToken });
  schoolClientCache.set(uniqueCode, { client, url: school.url });

  return drizzle(client, { schema: schoolSchema });
};

export const invalidateSchoolClient = (uniqueCode: string) => {
  schoolClientCache.delete(uniqueCode);
};
