#!/usr/bin/env node
/**
 * Applies migration 0006_tsvector_fulltext_search.sql to the DB.
 * Runs each statement separately (CONCURRENTLY can't run in a transaction).
 *
 * Usage: DATABASE_URL="..." node scripts/apply-migration-0006.mjs
 */
import pg from "/home/z/my-project/Trees-friend-/node_modules/.pnpm/pg@8.21.0/node_modules/pg/lib/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const migrationPath = join(__dirname, "..", "lib", "db", "migrations", "0006_tsvector_fulltext_search.sql");
const sql = readFileSync(migrationPath, "utf8");

// Split on semicolons followed by newlines, but preserve $$ blocks.
// Simple approach: split on lines, accumulate until we hit a line ending with ;
// and we're not inside a $$ block.
const statements = [];
let current = [];
let inDollarQuote = false;
for (const line of sql.split("\n")) {
  current.push(line);
  const dollarCount = (line.match(/\$\$/g) || []).length;
  if (dollarCount % 2 === 1) inDollarQuote = !inDollarQuote;
  if (!inDollarQuote && line.trim().endsWith(";")) {
    const stmt = current.join("\n").trim();
    if (stmt && !stmt.startsWith("--")) {
      statements.push(stmt);
    }
    current = [];
  }
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let succeeded = 0;
let failed = 0;
for (const stmt of statements) {
  // Skip comment-only statements
  const firstLine = stmt.split("\n").find((l) => !l.trim().startsWith("--")) ?? "";
  if (!firstLine) continue;
  try {
    await client.query(stmt);
    succeeded++;
    console.log("✓", firstLine.slice(0, 80));
  } catch (err) {
    failed++;
    console.error("✗", firstLine.slice(0, 80), "→", err.message);
  }
}

await client.end();
console.log(`\nDone: ${succeeded} succeeded, ${failed} failed`);
