import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schoolSchema from "./schemas/school";
import { schoolsSchema, tursoDatabasesSchema } from "./schemas/super";
import { eq } from "drizzle-orm";
import type { Env } from "../types/common-types";
import { getCommonDB } from "./common-client";

export const getSchoolDB = async (env: Env['Bindings'], uniqueCode: string) => {
  const commonDB = getCommonDB(env);

  // Lookup school's Turso DB
  const school = await commonDB.select({
    url: tursoDatabasesSchema.url,
    authToken: tursoDatabasesSchema.authToken,
  })
  .from(schoolsSchema)
  .innerJoin(tursoDatabasesSchema, eq(schoolsSchema.tursoDbId, tursoDatabasesSchema.id))
  .where(eq(schoolsSchema.uniqueCode, uniqueCode))
  .get();

  if (!school) throw new Error("School not found");

  const client = createClient({ url: school.url, authToken: school.authToken });
  return drizzle(client, { schema: schoolSchema });
};