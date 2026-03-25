**✅ Production-Grade Column Rename Strategy (classId → classSectionId)** 
This is the exact method used by companies like Vercel, Supabase, and large SaaS products when they do schema changes on live user data.

### Why You Cannot Do It Directly
Direct `ALTER TABLE ... RENAME COLUMN classId TO classSectionId` is **dangerous** in production because:
- Existing foreign keys, indexes, and triggers still reference the old name.
- Drizzle migration might generate `DROP COLUMN` + `ADD COLUMN` which fails on live data.
- SQLite (Turso) is stricter than PostgreSQL — some operations are not atomic.

### The Safe 5-Step Pattern (Zero Downtime, Fully Reversible)

This is the **industry standard** way:

1. **Add new column** (as nullable)
2. **Backfill data** (copy from old column)
3. **Update all references** (foreign keys, indexes, code, queries)
4. **Make new column NOT NULL + drop old column**
5. **Clean up** (remove old column completely)

You do this **in separate migrations**, one step at a time, so you can rollback at any point.

---

### Practical Example Using Your Real Schema

We will rename `classId` → `classSectionId` in `student_enrollments` table (the most common case in your app).

#### Step 1: Create Migration File Manually (Never let Drizzle auto-generate big changes)

Create a new file in your `school-migrations/` folder:

**`001_rename_classId_to_classSectionId_step1.sql`**

```sql
-- STEP 1: Add new column (nullable, safe)
ALTER TABLE student_enrollments 
ADD COLUMN classSectionId integer REFERENCES class_sections(id);

-- STEP 2: Backfill data from old column (copy existing values)
UPDATE student_enrollments 
SET classSectionId = classId 
WHERE classId IS NOT NULL;
```

**Run this migration** on all school databases using your `migration-node-app`.

---

#### Step 2: Second Migration (Update References)

Create next file: **`002_rename_classId_to_classSectionId_step2.sql`**

```sql
-- Update any other tables that reference the old column
-- (In your case, you may have references in assignments, fee_structures, etc.)

-- Example for assignments table
ALTER TABLE assignments 
ADD COLUMN classSectionId_temp integer REFERENCES class_sections(id);

UPDATE assignments 
SET classSectionId_temp = classId 
WHERE classId IS NOT NULL;

-- Drop old column after backfill (do this in next step)
```

Also update your **application code** in this step:
- Change all queries from `.classId` to `.classSectionId`
- Update Drizzle schema files
- Update relations

---

#### Step 3: Third Migration (Make New Column NOT NULL + Drop Old)

**`003_rename_classId_to_classSectionId_step3.sql`**

```sql
-- Make new column NOT NULL (now safe because data is copied)
ALTER TABLE student_enrollments 
RENAME COLUMN classSectionId TO classSectionId_temp;

ALTER TABLE student_enrollments 
ADD COLUMN classSectionId integer NOT NULL REFERENCES class_sections(id);

UPDATE student_enrollments 
SET classSectionId = classSectionId_temp;

-- Drop temporary column
DROP COLUMN classSectionId_temp;

-- Finally drop the old column
ALTER TABLE student_enrollments DROP COLUMN classId;
```

Do the same for other tables (assignments, fee_structures, etc.).

---

#### Step 4: Final Cleanup Migration

**`004_rename_classId_to_classSectionId_step4.sql`**

```sql
-- Drop any old indexes that referenced classId
DROP INDEX IF EXISTS idx_old_class_id;

-- Update any remaining foreign keys if needed
```

---

### How to Apply This in Your System

1. **Never run `drizzle-kit generate` for big changes** in production.
2. Create **named, step-by-step migration files** manually (as shown above).
3. Increase your `schema_version` in central DB after each successful batch.
4. Your `migration-node-app` should check `schema_version` before applying new steps.

Example in your `runSchoolMigrations`:

```ts
const targetVersion = 12; // increase this when you release new migration steps

const schoolsToMigrate = await centralDb
  .select()
  .from(tursoDatabasesSchema)
  .where(lt(tursoDatabasesSchema.schemaVersion, targetVersion));
```

---

### Bonus: Recommended Future Workflow (Production Safe)

**For any schema change in future:**

1. **Write the change plan** first (in Notion or comments).
2. **Break into 3–5 small migrations** (add column → backfill → switch code → drop old).
3. **Test on a staging Turso DB** first.
4. **Deploy migrations** during low-traffic window (e.g., 2 AM IST).
5. **Monitor** for 24–48 hours after migration.
6. **Only then** update your main app code to use the new column.

This way you can rollback any step if something goes wrong.

