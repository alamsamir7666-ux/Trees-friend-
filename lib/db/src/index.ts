import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
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

/**
 * Critical: attach an error handler to the pool's idle connections.
 *
 * Without this, when Supabase's PgBouncer pooler (port 6543) drops an
 * idle connection (which it does aggressively — typically after 60s of
 * idle, but sometimes sooner under load), pg-pool emits an 'error'
 * event on the BoundPool instance. Node.js treats unhandled 'error'
 * events as fatal and crashes the process with ECONNABORTED.
 *
 * This is the #1 cause of mysterious api-server crashes on long-running
 * deployments (Render, phone-as-server, any non-serverless setup that
 * holds a pool open for hours).
 *
 * The fix is to log the error instead of crashing. The pool will
 * automatically create a new connection on the next query.
 *
 * Reference: https://github.com/brianc/node-postgres/issues/1324
 */
pool.on("error", (err: Error) => {
  // Log and continue — the pool will create a new connection on next query.
  // ECONNABORTED, ECONNRESET, EPIPE are all normal when the pooler drops
  // idle connections.
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === "ECONNABORTED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT"
  ) {
    // Expected — pooler dropped an idle connection. Don't crash.
    // Use console.error instead of logger to avoid circular import.
    console.error(
      `[db-pool] ${code}: idle connection dropped by pooler (normal) — pool will reconnect on next query`,
    );
  } else {
    // Unexpected error — log loudly so we notice, but still don't crash.
    console.error(`[db-pool] unexpected pool error:`, err);
  }
});

export const db = drizzle(pool, { schema });

export * from "./schema";
