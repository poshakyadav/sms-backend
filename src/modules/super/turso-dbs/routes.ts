import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  jwtMiddleware,
  permissionMiddleware,
} from "../../../middleware/super-auth";
import { Env } from "../../../types/common-types";
import { getCommonDB } from "../../../db";
import { tursoDatabasesSchema } from "../../../db/schemas/super/turso-databases";
import { count, eq } from "drizzle-orm";

const tursoDbsRouter = new Hono<Env>();

tursoDbsRouter.use(
  "*",
  jwtMiddleware,
  permissionMiddleware(["canManageTursoDBs"])
);

const addSchema = z.object({
  url: z.string().url(),
  authToken: z.string(),
  createdByEmail: z.string().email(),
});
// === POST / to add a new Turso DB ===
tursoDbsRouter.post("/", zValidator("json", addSchema), async (c) => {
  try {
    const { url, authToken, createdByEmail } = c.req.valid("json");
    const db = getCommonDB(c.env);

    // Check if already exists
    const existing = await db
      .select()
      .from(tursoDatabasesSchema)
      .where(eq(tursoDatabasesSchema.url, url))
      .get();
    if (existing) return c.json({ error: "Database already configured" }, 400);

    // Insert to central
    const [newDb] = await db
      .insert(tursoDatabasesSchema)
      .values({ 
        url, 
        authToken, 
        createdByEmail })
      .returning();
      // lastMigrationAt: null by default
      // lastMigrationAt remains NULL until migration-node-app updates it

    return c.json(newDb, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET / to list all configured Turso DBs ===
// Add GET / for list, DELETE /:id, etc. as needed
tursoDbsRouter.get("/", async (c) => {
  const db = getCommonDB(c.env);
  const dbs = await db.select().from(tursoDatabasesSchema).all();
  return c.json(dbs);
});

// Get count of available (unassigned) DBs
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

export default tursoDbsRouter;
