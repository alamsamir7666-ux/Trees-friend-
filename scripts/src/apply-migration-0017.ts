// Apply migration 0017 to Supabase — adds checkout_session_id column + index.
// Run: cd lib/db && DATABASE_URL="..." npx tsx ../../scripts/src/apply-migration-0017.ts
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  console.log("✅ Connected to Supabase");

  // Check if column already exists (idempotent)
  const { rows } = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'checkout_session_id'
  `);

  if (rows.length > 0) {
    console.log("ℹ️  Column 'checkout_session_id' already exists — skipping ADD COLUMN");
  } else {
    console.log("➕ Adding column 'checkout_session_id'...");
    await client.query(`ALTER TABLE orders ADD COLUMN checkout_session_id text`);
    console.log("✅ Column added");
  }

  // Check if index already exists
  const { rows: idxRows } = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'orders' AND indexname = 'orders_checkout_session_id_idx'
  `);

  if (idxRows.length > 0) {
    console.log(
      "ℹ️  Index 'orders_checkout_session_id_idx' already exists — skipping CREATE INDEX",
    );
  } else {
    console.log("➕ Creating index 'orders_checkout_session_id_idx'...");
    await client.query(
      `CREATE INDEX orders_checkout_session_id_idx ON orders (checkout_session_id)`,
    );
    console.log("✅ Index created");
  }

  // Verify
  const { rows: verify } = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'checkout_session_id'
  `);
  console.log("🔍 Verification:", verify);

  console.log("\n🎉 Migration 0017 applied successfully!");
  await client.end();
}

main().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
