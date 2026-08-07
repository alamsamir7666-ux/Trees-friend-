import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { ensureConversationsTables } from "./lib/ensureConversationsTables";
import { ensurePresenceTables } from "./lib/ensurePresenceTables";
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
    ? (process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
        : [])
    : (process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
        : true);

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

// ─── Clerk proxy ─────────────────────────────────────────────────────────────
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// ─── Clerk middleware ─────────────────────────────────────────────────────────
app.use(clerkMiddleware({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY }));

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
app.use("/api", apiLimiter);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api", router);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");

  // Don't expose internal error details in production
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;

  res.status(500).json({ error: message });
});

export default app;
