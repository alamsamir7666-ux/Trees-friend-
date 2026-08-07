import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Database connection pool — configured for serverless.
 *
 * FIX: previously used default `pg.Pool` config (`max: 10` connections),
 * which is wrong for Vercel serverless. Each Lambda invocation gets its
 * own pool, so 10 concurrent invocations = 100 connections — exceeds
 * Supabase's connection limit and causes "too many connections" errors.
 *
 * Now configured with:
 *   - max: 1 (one connection per Lambda instance — the pooler handles
 *     multiplexing across instances)
 *   - idleTimeoutMillis: 30s (close idle connections quickly so the
 *     Lambda can freeze without holding connections)
 *   - connectionTimeoutMillis: 10s (fail fast if the DB is unreachable)
 *   - ssl: true (required by Supabase/Neon)
 *
 * For true serverless HTTP-based connections (no pool at all), consider
 * migrating to @vercel/postgres or Supabase's REST API in the future.
 * The current config works correctly on Vercel because Supabase's
 * PgBouncer pooler (port 6543) handles connection multiplexing server-side.
 */
const isProduction = process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In production (serverless), use a small pool. Each Lambda instance
  // gets its own pool, so max=1 means N concurrent Lambdas = N DB
  // connections, which Supabase's pooler handles fine. In dev (long-lived
  // process), use a larger pool for better concurrent query performance.
  max: isProduction ? 1 : 10,
  idleTimeoutMillis: isProduction ? 30_000 : 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
