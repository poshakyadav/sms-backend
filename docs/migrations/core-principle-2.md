**How to Safely Test Migrations on `school-migrations-dev` Before Applying to Real School Databases**

This is one of the most important production-grade practices in your system.  
You **never** directly apply a new migration to real school databases without testing it first.

### Why This Safe Testing Process is Necessary

- Migrations can be **destructive** (DROP COLUMN, ALTER TABLE, etc.).
- Real school databases contain **live student data, marks, fees, etc.**
- A single mistake in migration can corrupt data or break the app for all schools.
- You want to test **exactly the same SQL** that will run in production, but on a **safe, isolated** database.

---

### The Safe Testing Workflow (Production Standard)

Here is the **complete, best-practice flow** we implemented:

1. Make schema changes in code.
2. Generate migrations into `school-migrations-dev` (dev folder).
3. Run migration on **test database** (`TEST_TURSO_DATABASE_URL`).
4. Verify everything works (run your Vitest tests, manual checks).
5. If successful → copy/move the migration to `school-migrations-prod`.
6. Run migration on real school databases using the prod folder.

This way, you **never risk** real data until you are 100% confident.

---

### Step-by-Step Implementation (with Code)

#### 1. Two Separate Migration Folders

You already have:

- `school-migrations-dev` → Used only for testing
- `school-migrations-prod` → Used for real schools

#### 2. Two Drizzle Config Files

**`drizzle.school.dev.config.ts`**

```ts
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
```

**`drizzle.school.prod.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schemas/school/*.ts",
  out: "./school-migrations-prod",
  dialect: "turso",
  dbCredentials: {
    url: process.env.SCHOOL_TURSO_DATABASE_URL!,
    authToken: process.env.SCHOOL_TURSO_AUTH_TOKEN!,
  },
});
```

#### 3. Package.json Scripts (for easy testing)

```json
"scripts": {
  "db:generate:school:dev": "dotenv -e .dev.vars -- drizzle-kit generate --config drizzle.school.dev.config.ts",
  "db:generate:school:prod": "dotenv -e .dev.vars -- drizzle-kit generate --config drizzle.school.prod.config.ts",

  "db:migrate:test": "dotenv -e .dev.vars -- tsx ../migration-node-app/src/server.ts --test",   // Test DB
  "db:migrate:prod": "dotenv -e .dev.vars -- tsx ../migration-node-app/src/server.ts"           // Real schools
}
```

#### 4. Migration Node App (`src/server.ts`) – Supports Test Mode

```ts
app.post("/migrate-all", async (c) => {
  const isTest = c.req.query("test") === "true"; // ?test=true

  // ... rest of your code

  const migrationResult = await runSchoolMigrations(url, authToken, isTest);
});
```

#### 5. `runSchoolMigrations` Function (Key Logic)

```ts
export async function runSchoolMigrations(
  url: string,
  authToken: string,
  isTest = false
) {
  const migrationsPath = isTest ? DEV_MIGRATIONS_PATH : PROD_MIGRATIONS_PATH;

  // Apply migration
  await migrate(db, { migrationsFolder: migrationsPath });

  // Only update central versioning if NOT in test mode
  if (!isTest) {
    // update schemaVersion and lastMigrationAt in central DB
  } else {
    console.log("ℹ️ Test mode: Skipping central versioning update");
  }
}
```

---

### Practical Example: How You Use It Daily

**Scenario**: You added a new column `isActive` to `exam_marks` table.

1. **Generate dev migration**

   ```bash
   npm run db:generate:school:dev
   ```

2. **Test the migration safely**

   ```bash
   npm run db:migrate:test
   ```

3. **Verify**

   - Run your Vitest tests
   - Manually check the test database using Drizzle Studio or Turso console
   - Confirm the new column exists and data is correct

4. **If everything is good → Promote to production**

   - Copy the latest migration folder from `school-migrations-dev` to `school-migrations-prod`
   - Or run `npm run db:generate:school:prod` after you are sure

5. **Apply to real schools**
   ```bash
   npm run db:migrate:prod
   ```

---

### Best Practices You Should Follow

- Always generate to **dev** folder first.
- Never manually edit migration files in `school-migrations-prod`.
- After successful test, **manually copy** the migration folder to prod (this is the safe gate).
- Increment `newVersion` in `runSchoolMigrations` only when promoting to prod.
- Keep `school-migrations-dev` clean (you can delete old dev migrations after promotion).
