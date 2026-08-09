/**
 * Industry-standard HTTP error handling for Express.
 *
 * ─── Problem this solves ────────────────────────────────────────────────────
 *
 * The prior pattern (215 try/catches across the codebase) had three flaws:
 *
 *  1. Every route reinvented `res.status(500).json({ error: "..." })` — the
 *     global error handler in `app.ts` was effectively dead code for route
 *     errors (0 uses of `next(err)`).
 *
 *  2. ~50% of catch blocks never logged `err`, so failures vanished silently
 *     from production logs.
 *
 *  3. `throw new Error("Not found")` couldn't carry an HTTP status, so callers
 *     had no way to distinguish 400 vs 401 vs 404 vs 500 without ad-hoc
 *     `res.status(...)` calls scattered through business logic.
 *
 * ─── The pattern ────────────────────────────────────────────────────────────
 *
 *  • `HttpError` — an Error subclass carrying `status` + optional `code` +
 *    optional `details` (for Zod-style field errors). Set `expose = true` on
 *    instances whose message is safe to show to clients (4xx by default).
 *
 *  • `asyncHandler(fn)` — wraps an async route handler so any rejected promise
 *    is forwarded to Express via `next(err)`. Eliminates the boilerplate
 *    `try { ... } catch (err) { res.status(500).json(...) }` pattern.
 *
 *  • The global error handler in `app.ts` does the right thing:
 *      - HttpError → use `err.status` and (if exposed) `err.message`
 *      - ZodError → 400 with `details[]`
 *      - everything else → 500 + generic message in production
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   import { asyncHandler, HttpError } from "../lib/errors";
 *
 *   router.post("/orders", requireAuth, validateBody(CreateOrderBody),
 *     asyncHandler(async (req, res) => {
 *       const order = await createOrder(req.body);
 *       if (!order) throw new HttpError(404, "Cart is empty");
 *       res.status(201).json(order);
 *     })
 *   );
 *
 * ─── Migration strategy ─────────────────────────────────────────────────────
 *
 *  Routes can be migrated incrementally. Existing `try/catch` blocks still
 *  work — they just become unnecessary. The global error handler now handles
 *  both `next(err)`-forwarded errors AND legacy inline `res.status(...)` calls.
 */

import type { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodError } from "zod";
import crypto from "crypto";
import { logger } from "./logger";
import { describeError } from "./describeError";

/**
 * PostgreSQL error codes used in this codebase. The `pg` driver surfaces
 * these as `err.code` on thrown errors — they're string codes (not numbers)
 * because Postgres defines them as 5-character SQLSTATE codes.
 *
 * See https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR_CODE = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  NOT_NULL_VIOLATION: "23502",
} as const;

/**
 * Type guard: was this thrown value a Postgres error with a `.code` property?
 *
 * The `pg` driver throws `DatabaseError` instances with `code`, `detail`,
 * `constraint`, etc. — but its TypeScript types don't surface cleanly
 * through Drizzle, so we narrow at runtime instead.
 */
interface PgErrorLike {
  code?: string;
  message: string;
  detail?: string;
  constraint?: string;
}
export function isPgError(err: unknown): err is PgErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/**
 * Generate a unique ID by combining a prefix with `numBytes` of crypto randomness.
 *
 * Uses `crypto.randomBytes` (cryptographically secure, unguessable) rather than
 * `Math.random()` (predictable). The result is uppercase hex for readability.
 *
 * Collision probability:
 *   4 bytes (32 bits)  = ~4 billion possibilities  — ~65k IDs for 50% collision chance
 *   6 bytes (48 bits)  = ~281 trillion possibilities — ~16M IDs for 50% collision chance
 *   8 bytes (64 bits)  = ~18 quintillion              — ~4 billion IDs for 50% collision chance
 *
 * For order tracking IDs, 6 bytes is the right trade-off: short enough to be
 * readable in a URL, long enough that collisions are effectively impossible
 * at marketplace scale.
 */
export function generateId(prefix: string, numBytes: number = 6): string {
  return prefix + crypto.randomBytes(numBytes).toString("hex").toUpperCase();
}

/**
 * Retry a DB INSERT operation on unique-constraint violation (PG error 23505).
 *
 * The `generateId` function produces a random ID, and `insertFn` uses it to
 * insert a row. If the INSERT fails with a unique violation (astronomically
 * unlikely with 6+ bytes, but possible), `generateId` is called again and
 * the INSERT is retried. Up to `maxRetries` attempts.
 *
 * Usage:
 *   const order = await retryOnUniqueViolation(
 *     () => generateId("EE", 6),
 *     (trackingId) => db.insert(ordersTable).values({ trackingId, ... }).returning(),
 *   );
 *
 * Throws the last error if all retries fail.
 */
export async function retryOnUniqueViolation<T>(
  generateId: () => string,
  insertFn: (id: string) => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const id = generateId();
    try {
      return await insertFn(id);
    } catch (err) {
      lastError = err;
      if (isPgError(err) && err.code === PG_ERROR_CODE.UNIQUE_VIOLATION && attempt < maxRetries - 1) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * HTTP error with status code, optional machine-readable `code`, and optional
 * `details` payload (e.g. Zod issues, field-level validation errors).
 *
 * By default, 4xx errors are exposed to the client (message is safe to show);
 * 5xx errors are NOT exposed (the global handler substitutes a generic
 * "Internal server error" in production). Override with `expose: false` for
 * sensitive 4xx cases, or `expose: true` for 5xx cases where the message is
 * known to be safe (rare).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    status: number,
    message: string,
    opts: {
      code?: string;
      details?: unknown;
      expose?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HttpError";
    this.status = status;
    this.code = opts.code;
    this.details = opts.details;
    // 4xx defaults to exposed; 5xx defaults to hidden.
    this.expose = opts.expose ?? (status >= 400 && status < 500);
    // Restore prototype chain — needed when targeting ES5; harmless otherwise.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Convenience factories — the most common HTTP error cases. */
  static badRequest(message = "Bad request", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(400, message, opts);
  }
  static unauthorized(message = "Authentication required", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(401, message, opts);
  }
  static forbidden(message = "Forbidden", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(403, message, opts);
  }
  static notFound(message = "Not found", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(404, message, opts);
  }
  static conflict(message = "Conflict", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(409, message, opts);
  }
  static unprocessableEntity(message = "Unprocessable entity", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(422, message, opts);
  }
  static tooManyRequests(message = "Too many requests", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(429, message, opts);
  }
  static internal(message = "Internal server error", opts: Omit<NonNullable<ConstructorParameters<typeof HttpError>[2]>, "expose"> = {}) {
    return new HttpError(500, message, opts);
  }
}

/**
 * Wrap an async Express route handler so rejected promises are forwarded to
 * Express via `next(err)`. The global error handler in `app.ts` then handles
 * them uniformly.
 *
 * Eliminates the `try { ... } catch (err) { logger.error(...); res.status(500).json(...) }`
 * boilerplate repeated 215+ times across this codebase.
 *
 * Works for both `async` functions and functions that return a Promise.
 *
 * Type note: the inner handler is typed with `any` for `req` and `res` so
 * callers can pass `ApiRequest<...>`-typed handlers without friction — the
 * `ApiRequest` type extends `Request`, so it's assignable. The return type
 * is intentionally `Promise<unknown>` (not `Promise<void>`) so handlers
 * that accidentally return a value don't fail typecheck (the value is
 * discarded by Express anyway).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncRequestHandler = (req: any, res: any, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * The global error handler. Mount once at the end of the Express middleware
 * chain in `app.ts`:
 *
 *   import { errorHandler } from "./lib/errors";
 *   app.use(errorHandler);
 *
 * Behavior:
 *  • `HttpError` → `err.status`, `err.message` (if `expose`), `err.code`,
 *    `err.details` (if any).
 *  • `ZodError`  → 400 with `details[]` (handles the rare case where a Zod
 *    schema is parsed outside the `validateBody` middleware).
 *  • Anything else → 500 + generic message in production, `err.message` in dev.
 *
 * Logs every error with the original `err` attached so production logs always
 * have the full stack trace + cause chain — closes the "50% of catches never
 * log err" gap.
 *
 * Includes request context (method, url, userId) so logs are actionable
 * without having to correlate with the request log entry.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Attach request context for every error log — closes the gap where ~50%
  // of legacy catch blocks never logged `err` at all.
  const logContext = {
    err,
    method: req.method,
    url: req.url?.split("?")[0], // never log query strings (may contain tokens)
    userId: (req as Request & { userId?: string }).userId,
  };

  // ─── HttpError: caller-specified status + (optionally) message ──────────
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      logger.error(logContext, err.message);
    } else {
      // 4xx errors are expected; log at warn so they don't trigger pager alerts.
      logger.warn(logContext, err.message);
    }
    const body: Record<string, unknown> = {
      error: err.expose ? err.message : "Internal server error",
    };
    if (err.code) body.code = err.code;
    if (err.expose && err.details !== undefined) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // ─── ZodError: 400 with field-level details (rare; validateBody handles most) ──
  if (err instanceof ZodError) {
    logger.warn(logContext, "Zod validation failed outside validateBody middleware");
    const details = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json({
      error: details[0]?.message ?? "Validation failed",
      details,
    });
    return;
  }

  // ─── Unknown error: always 500, hide details in production ──────────────
  logger.error(logContext, describeError(err));
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : describeError(err);
  res.status(500).json({ error: message });
}
