In development it’s easy to reset databases, but **in production you cannot reset** — you have real student data, payments, exams, etc.

Here is the **exact professional approach** I use in all production apps (including multi-tenant Turso setups like yours).

---

### Core Principle for Production

**“Never make a migration that can fail on existing data.”**

Drizzle-kit is very good at generating migrations, but it assumes the database is empty or matches the previous snapshot.  
When you rename columns, change relationships (`classId` → `classSectionId`), or add `NOT NULL` columns, it creates **dangerous** SQL (DROP COLUMN, ADD NOT NULL without default).

**Solution**: You must **manually control and split** big changes into safe, multi-step migrations.

---

### Recommended Production Workflow (Use This Forever)

#### 1. Never Generate Migrations Blindly in Production
- In **development**: You can run `npm run db:generate:school` freely.
- In **production**: You **never** let Drizzle auto-generate destructive changes.

Instead, follow this **4-step safe process** every time you change the schema:

**Step A: Plan the change (on paper or Notion)**
- Example: “I want to change `student_enrollments.classId` → `classSectionId`”
- Break it into small safe steps.

**Step B: Write manual safe migrations (recommended)**
Create a new migration file manually in `school-migrations/` with **only safe SQL**.

Example safe migration for adding `NOT NULL` column:

```sql
-- 001_add_school_id_safe.sql

-- Step 1: Add column as NULLABLE with default
ALTER TABLE school_users ADD COLUMN school_id integer DEFAULT 1;

-- Step 2: Backfill existing data (if needed)
UPDATE school_users SET school_id = 1 WHERE school_id IS NULL;

-- Step 3: Make it NOT NULL (safe now)
ALTER TABLE school_users RENAME COLUMN school_id TO school_id_temp;
ALTER TABLE school_users ADD COLUMN school_id integer NOT NULL DEFAULT 1;
UPDATE school_users SET school_id = school_id_temp;
DROP COLUMN school_id_temp;
```

**Step C: Test on staging**
- Create one temporary Turso DB as staging.
- Run your migration app on it first.

**Step D: Apply to production schools (rolling)**
- Update your central `turso_databases` table with a `migration_version` column.
- Only apply new migrations to schools where `migration_version < current_version`.
- Run migrations one school at a time (or in batches during low-traffic hours).

---

### Specific Patterns You Should Use in Future

| Change Type                        | Safe Way (Never do this directly)                          |
|------------------------------------|-------------------------------------------------------------|
| Add `NOT NULL` column              | Add as nullable → backfill → rename + make NOT NULL        |
| Rename column (`classId` → `classSectionId`) | Add new column → copy data → update all references → drop old |
| Change relationship (classId → classSectionId) | Same as above + update foreign keys in steps               |
| Add new table                      | Just create it (safe)                                       |
| Big refactor (like your class-section change) | Do it in 3–4 separate migrations over 1–2 weeks            |

---

### Recommended Tools & Setup for Your Project

1. **Add versioning in central DB**
   Add this column to `turso_databases` table:
   ```sql
   ALTER TABLE turso_databases ADD COLUMN schema_version integer DEFAULT 0;
   ```

   Then in your `runSchoolMigrations` function:
   ```ts
   const currentVersion = 12; // increase this when you make changes
   // Only migrate schools where schema_version < currentVersion
   ```

2. **Use named migrations (manual)**
   Stop relying only on auto-generated ones.  
   Name them like:
   - `001_add_school_id_to_users.sql`
   - `002_convert_to_class_section_id.sql`

3. **Create a staging database**
   In your central DB, always keep one extra row called "staging-db" that you use for testing migrations before production.

4. **Add a dry-run mode**
   Modify `runSchoolMigrations` to accept `--dry-run` flag that only prints SQL without executing.

---

### What You Should Do Right Now (Immediate Action)

Since you are still in **development stage**:

1. **Reset both school databases** (safe because not launched yet)
   - Delete the bad migration folder.
   - Run `npm run db:generate:school` again (clean).
   - Run your migration app (or with reset flag).

2. **After reset, add the `schema_version` column** to your central DB and to the `turso_databases` table.

3. **From now on, follow the 4-step process** above for every schema change.

This way, when you go to production, you will never face these migration failures again.