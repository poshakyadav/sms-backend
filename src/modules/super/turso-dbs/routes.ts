// src/modules/super/turso-dbs/routes.ts

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql, count, eq, and, ne } from "drizzle-orm";
import {
  jwtMiddleware,
  requireSuperPermission,
  superTokenValidationMiddleware,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { tursoDatabasesSchema } from "../../../db/schemas/super/turso-databases";
import { redactTursoDb, verifyTursoConnection } from "./utils";

const tursoDbsRouter = new Hono<Env>();

tursoDbsRouter.use(
  "*",
  jwtMiddleware,
  superTokenValidationMiddleware,
  requireSuperPermission("turso.manage")
);

// A Turso connection string always looks like libsql://<host>/... Enforcing
// this in the backend too (not just the frontend pattern) stops a malformed
// entry — e.g. a plain https:// URL pasted by mistake — from ever reaching
// the value that getSchoolDB() depends on.
const tursoUrlSchema = z
  .string()
  .url()
  .refine((val) => val.startsWith("libsql://"), {
    message: "URL must start with libsql://",
  });

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const addSchema = z.object({
  url: tursoUrlSchema,
  authToken: z.string().min(1, "Auth token is required"),
  createdByEmail: z.string().email(),
});

const updateSchema = z
  .object({
    url: tursoUrlSchema.optional(),
    authToken: z.string().min(1, "Auth token cannot be empty").optional(),
    // Explicit opt-in required to change the URL of a DB that's already
    // assigned to a school — see the isAssigned guard in the PATCH handler.
    force: z.boolean().optional().default(false),
  })
  .refine((data) => data.url !== undefined || data.authToken !== undefined, {
    message: "Provide a url and/or authToken to update",
    path: ["url"],
  });

// === POST / to add a new Turso DB ===
tursoDbsRouter.post("/", zValidator("json", addSchema), async (c) => {
  try {
    const { url, authToken, createdByEmail } = c.req.valid("json");
    const db = getCommonDB(c.env);

    const existing = await db
      .select({ id: tursoDatabasesSchema.id })
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.url, url))
      .get();
    if (existing) return c.json({ error: "Database already configured" }, 400);

    const [newDb] = await db
      .insert(tursoDatabasesSchema)
      .values({ url, authToken, createdByEmail })
      .returning();
    // lastMigrationAt remains NULL until migration-node-app updates it

    return c.json(redactTursoDb(newDb), 201);
  } catch (error: any) {
    if (String(error?.message ?? "").includes("UNIQUE")) {
      return c.json({ error: "Database already configured" }, 409);
    }
    return c.json({ error: error.message }, 500);
  }
});

// === GET / to list all configured Turso DBs ===
tursoDbsRouter.get("/", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const dbs = await db.select().from(tursoDatabasesSchema).all();
    return c.json(dbs.map(redactTursoDb));
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get count of available (unassigned) DBs
// NOTE: this must stay registered before GET /:id so "available-count"
// isn't swallowed as an :id param.
tursoDbsRouter.get("/available-count", async (c) => {
  try {
    const db = getCommonDB(c.env);
    const countResult = await db
      .select({ value: count() })
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.isAssigned, false))
      .get();
    return c.json({ available: countResult?.value ?? 0 });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET /:id — single record, used by the edit screen ===
tursoDbsRouter.get("/:id", zValidator("param", idParamSchema), async (c) => {
  try {
    const { id } = c.req.valid("param");
    const db = getCommonDB(c.env);

    const existing = await db
      .select()
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.id, id))
      .get();

    if (!existing) return c.json({ error: "Turso database not found" }, 404);

    return c.json(redactTursoDb(existing));
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === PATCH /:id — update a Turso DB's connection URL and/or auth token ===
//
// `url`/`authToken` here are the literal credentials getSchoolDB(env,
// schoolCode) uses to reach a school's live database, so this endpoint has
// three guardrails, in order:
//
//   1. Uniqueness — a new `url` can't collide with another registered DB.
//   2. Assigned-DB URL changes require `force: true` — changing the URL of
//      an already-assigned DB almost always means "this school is about to
//      point at the wrong database" unless done on purpose, so we make that
//      explicit instead of letting it happen silently.
//   3. Connectivity check — before persisting, we open a real connection
//      with the *new* url/token and run SELECT 1. If that fails, the whole
//      update is rejected with 422 so a typo can never get saved.
tursoDbsRouter.patch(
  "/:id",
  zValidator("param", idParamSchema),
  zValidator("json", updateSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { url, authToken, force } = c.req.valid("json");
    const db = getCommonDB(c.env);

    try {
      const existing = await db
        .select()
        .from(tursoDatabasesSchema)
        .where(eq(tursoDatabasesSchema.id, id))
        .get();

      if (!existing) return c.json({ error: "Turso database not found" }, 404);

      const urlChanged = url !== undefined && url !== existing.url;

      if (urlChanged) {
        const conflict = await db
          .select({ id: tursoDatabasesSchema.id })
          .from(tursoDatabasesSchema)
          .where(
            and(eq(tursoDatabasesSchema.url, url), ne(tursoDatabasesSchema.id, id))
          )
          .get();

        if (conflict) {
          return c.json(
            { error: "Another database is already registered with this URL" },
            409
          );
        }

        if (existing.isAssigned && !force) {
          return c.json(
            {
              error:
                "This database is currently assigned to a school. Changing its URL will point that school's connection at a different database. Resubmit with `force: true` to confirm.",
              code: "ASSIGNED_DB_URL_CHANGE_REQUIRES_CONFIRMATION",
            },
            409
          );
        }
      }

      const nextUrl = url ?? existing.url;
      const nextAuthToken = authToken ?? existing.authToken;

      // Only worth re-verifying when something actually changed.
      if (urlChanged || authToken !== undefined) {
        const reachable = await verifyTursoConnection(nextUrl, nextAuthToken);
        if (!reachable) {
          return c.json(
            {
              error:
                "Could not connect using the provided URL/token — nothing was saved. Double-check the URL and that the token hasn't been revoked.",
            },
            422
          );
        }
      }

      const [updated] = await db
        .update(tursoDatabasesSchema)
        .set({
          ...(url !== undefined ? { url } : {}),
          ...(authToken !== undefined ? { authToken } : {}),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(tursoDatabasesSchema.id, id))
        .returning();

      return c.json(redactTursoDb(updated));
    } catch (error: any) {
      // Race guard — mirrors the pattern used for admission-number
      // uniqueness: two concurrent updates to the same URL both pass the
      // manual check, one wins the DB-level unique constraint.
      if (String(error?.message ?? "").includes("UNIQUE")) {
        return c.json(
          { error: "Another database is already registered with this URL" },
          409
        );
      }
      return c.json({ error: error.message }, 500);
    }
  }
);

export default tursoDbsRouter;