# Database Fix Plan: User Identity Split (CRITICAL)

## The Problem

`users.id` is `serial` (integer), but **every per-user table stores the Clerk ID
as `text` with NO foreign key**. 16+ tables are affected:

| Table | Column | Type | FK? |
|-------|--------|------|-----|
| addresses | user_id | text | NO |
| orders | user_id | text | NO |
| cart_items | user_id | text | NO |
| wishlist | user_id | text | NO |
| reviews | user_id | text | NO |
| loyalty_points | user_id | text | NO |
| loyalty_transactions | user_id | text | NO |
| referrals | referrer_id, referred_id | text | NO |
| abandoned_carts | user_id | text | NO |
| conversations | buyer_id | text | NO |
| messages | sender_id | text | NO |
| follows | user_id | text | NO |
| product_qa | user_id | text | NO |
| email_preferences | user_id | text | NO |
| subscriptions | user_id | text | NO |
| audit_logs | admin_id | text | NO |

**Risk:** Deleting a Clerk user leaves orphan rows in 16+ tables. No `ON DELETE`
behavior because there's no FK. The only mitigation is a Clerk `user.deleted`
webhook cleaning up — the DB doesn't enforce it.

## The Fix (2 options)

### Option A: Add `users.clerk_id` + FK all per-user tables to it (Recommended)

```sql
-- Step 1: Ensure users.clerk_id has a unique constraint (it already does in the schema)
ALTER TABLE users ADD CONSTRAINT users_clerk_id_key UNIQUE (clerk_id);

-- Step 2: Add FKs from all per-user tables to users.clerk_id
-- Use ON DELETE CASCADE for data that should be cleaned up when a user is deleted
-- Use ON DELETE SET NULL for audit/history data that should be retained

ALTER TABLE addresses
  ADD CONSTRAINT addresses_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE CASCADE;

ALTER TABLE orders
  ADD CONSTRAINT orders_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE RESTRICT;
  -- RESTRICT: never auto-delete orders (financial/audit trail)

-- ... repeat for all 16 tables
```

**Risk:** If any existing row has a `user_id` that doesn't match a `users.clerk_id`,
the FK addition will fail. Need to check for orphans first:

```sql
-- Pre-migration check: find orphaned rows
SELECT COUNT(*) FROM addresses a
  LEFT JOIN users u ON a.user_id = u.clerk_id
  WHERE u.id IS NULL;
```

### Option B: Keep `text` user_id, add a cleanup trigger

Less invasive — add a trigger on `users` that cascades the delete to all
per-user tables when a user row is deleted. Doesn't add FKs (so no orphan
detection), but does ensure cleanup.

```sql
CREATE OR REPLACE FUNCTION cleanup_user_data()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM addresses WHERE user_id = OLD.clerk_id;
  DELETE FROM cart_items WHERE user_id = OLD.clerk_id;
  DELETE FROM wishlist WHERE user_id = OLD.clerk_id;
  -- ... etc for all 16 tables
  RETURN OLD;
END;
$$ language 'plpgsql';

CREATE TRIGGER on_user_delete
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION cleanup_user_data();
```

## Recommendation

**Option A** is the industry-standard fix. It:
- Enforces referential integrity at the DB layer
- Prevents orphans from being created (INSERT will fail if user_id doesn't exist)
- Auto-cleans dependent data on user delete (via CASCADE)
- Makes the schema self-documenting

**Before applying**, run the orphan-check queries to see if any existing data
would cause the FK addition to fail. If orphans exist, they need to be cleaned
up first (either delete them, or create placeholder `users` rows for them).

## Status

**NOT APPLIED** — this is a schema-level change that could fail if there are
existing orphaned rows. Needs:
1. Run orphan-check queries to assess the scope
2. Clean up any orphans found
3. Apply the FK migration
4. Update the Drizzle schema to match

This should be done in a dedicated maintenance window with a database backup.
