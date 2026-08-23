import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./lib/errors";
import { responseHelpersMiddleware } from "./lib/responses";
import { ensureConversationsTables } from "./lib/ensureConversationsTables";
import { ensurePresenceTables } from "./lib/ensurePresenceTables";
import { ensureAiTables } from "./lib/ensureAiTables";
// BUG-E1 critical fix: on startup, mark stale-model embeddings for re-embedding.
import { markStaleEmbeddingsForReembedding } from "./lib/kbEmbeddings";
import { apiLimiter } from "./middlewares/rateLimiter";

const app: Express = express();

// ─── Self-bootstrap DB schema for messaging + presence ───────────────────────
// Runs on every cold start (both long-lived `index.ts` AND Vercel serverless
// `vercel.ts`), since both import `app.ts`. The migrations are fully idempotent
// (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS) so concurrent
// invocations are safe — Postgres serializes DDL inside its own transaction
// per statement. We intentionally do NOT await this; the first request that
// hits /conversations or /presence before the migration finishes will get a
// 500, but the migration completes within milliseconds and subsequent
// requests succeed. This trade-off is preferable to blocking the entire app
// on a DB round-trip during cold start.
ensureConversationsTables().catch((err) => {
  logger.error({ err }, "ensureConversationsTables failed at app init");
});
ensurePresenceTables().catch((err) => {
  logger.error({ err }, "ensurePresenceTables failed at app init");
});
ensureAiTables().catch((err) => {
  logger.error({ err }, "ensureAiTables failed at app init");
});
// BUG-E1 critical fix: after ensureAiTables adds the embedding_model column,
// mark any stale-model embeddings (from a different model than the current
// GEMINI_EMBEDDING_MODEL) as 'pending' for re-embedding. The background job
// will pick them up on the next run (30s on Render, 5min on Vercel).
// Fire-and-forget — non-fatal if it fails (the search SQL also guards with
// CASE WHEN embedding_model = $model, so stale embeddings are excluded from
// similarity comparison even if this check doesn't run).
markStaleEmbeddingsForReembedding().catch(() => {});

// ─── Security: Trust proxy (required if behind nginx/load balancer) ──────────
app.set("trust proxy", 1);

// ─── Security: Remove X-Powered-By ──────────────────────────────────────────
app.disable("x-powered-by");

// ─── Structured request logging ──────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0], // Never log query strings (may contain tokens)
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ─── Security Headers ────────────────────────────────────────────────────────
app.use((_req: Request, res: Response, next: NextFunction) => {
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");
  // XSS protection (legacy browsers)
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Strict Transport Security (only in production)
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ─── CORS ────────────────────────────────────────────────────────────────────
// SECURITY: in production, ALLOWED_ORIGINS MUST be set to the exact
// frontend URL(s). If unset in production, we default to an empty array
// (deny all) rather than `true` (allow all) — the previous fallback of
// `true` combined with `credentials: true` was the worst-case CORS
// config (any website could make credentialed requests). In development,
// `true` is convenient for local testing across ports.
const allowedOrigins: boolean | string[] =
  process.env.NODE_ENV === "production"
    ? process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : []
    : process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : true;

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.ALLOWED_ORIGINS || (Array.isArray(allowedOrigins) && allowedOrigins.length === 0))
) {
  logger.warn(
    "ALLOWED_ORIGINS is not set in production — CORS will deny ALL cross-origin requests. " +
      "Set ALLOWED_ORIGINS to your frontend URL(s) (comma-separated) in your env vars.",
  );
}

app.use(
  cors({
    credentials: true,
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    maxAge: 86400, // Cache preflight for 24 hours
  }),
);

// ─── Body parsing with size limits (prevent large payload attacks) ────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// ─── Response helpers (res.ok(), res.created(), res.noContent(), res.message()) ──
// See lib/responses.ts for the full contract. Mount after body parsers, before
// routes, so every handler has access to the helpers.
app.use(responseHelpersMiddleware);

// ─── Clerk proxy ─────────────────────────────────────────────────────────────
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// ─── Clerk middleware ─────────────────────────────────────────────────────────
// Clerk's middleware throws a SyntaxError when it tries to decode a non-Clerk
// Bearer token (e.g. a guest JWT or a mobile-auth JWT). Without this wrapper,
// Express's error handler turns the throw into a 500. The wrapper catches
// the error and continues — requireGuestOrAuth/resolveIdentity handle the
// token via their own verification paths (guest JWT via verifyGuestJwt, mobile
// JWT via verifyMobileJwt, Clerk via getAuth's try-catch in resolveIdentity).
const clerkMiddlewareWrapper = (
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) => {
  clerkMiddleware({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY })(
    req,
    res,
    (err?: unknown) => {
      // Swallow Clerk parse errors — the request will be authenticated via
      // requireGuestOrAuth (guest JWT) or requireAuth (mobile JWT) instead.
      // This is safe because Clerk's middleware's only side effect is setting
      // req.auth — if it throws, req.auth is undefined, which resolveIdentity
      // already handles via its try-catch on getAuth(req).
      if (err) {
        // Log at debug level so ops can see if this happens in production
        // (it shouldn't — Clerk should only see Clerk tokens).
        logger.debug({ err: String(err).slice(0, 200) }, "Clerk middleware error (swallowed — non-Clerk Bearer token)");
      }
      next();
    },
  );
};
app.use(clerkMiddlewareWrapper);

// ─── Rate Limiting ───────────────────────────────────────────────────────────
// The global apiLimiter is IP-based (no userId needed) and runs before
// requireAuth, so it's safe to mount at the app level. It provides a
// coarse-grained ceiling on total request volume per IP.
//
// Per-route limiters (checkoutLimiter, authLimiter, etc.) are applied at
// the ROUTE level after requireAuth, so they can key on userId in
// addition to IP — see routes/orders.ts, routes/mobileAuth.ts, etc.
// Mounting them here (before requireAuth) would make req.userId always
// undefined, defeating the per-user keying.
app.use("/api", apiLimiter); // covers both /api and /api/v1 (since /api/v1 starts with /api)

// ─── API routes (versioned + backward-compat alias) ──────────────────────────
//
// The API is mounted under TWO prefixes:
//
//   1. `/api/v1`  — the canonical, versioned path going forward. New clients
//                   (Flutter app, future SDKs) should use this. When a v2 is
//                   needed, mount the new router under `/api/v2` and leave
//                   `/api/v1` untouched — old clients keep working.
//
//   2. `/api`     — backward-compat alias for the existing frontend + any
//                   third-party callers already integrated against `/api/*`.
//                   Routes a request to `/api/orders` to the same handler as
//                   `/api/v1/orders`. This alias will be deprecated in a
//                   future release (add a `Deprecation: true` header + log a
//                   warning), but for now it's transparent.
//
// Both prefixes share the same router instance, so there's zero duplication —
// adding a new route automatically makes it available under both paths.
app.use("/api/v1", router);
app.use("/api", router);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Replaces the prior inline handler. See `lib/errors.ts` for the full
// behavior contract (HttpError → status + optional exposed message;
// ZodError → 400 with details[]; unknown → 500 with details hidden in prod).
// Every error is logged with method + url + userId context attached.
app.use(errorHandler);

export default app;
