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
import smsWebhookRouter from "./routes/smsWebhook";
import { logger } from "./lib/logger";
import { apiLimiter, checkoutLimiter, newsletterLimiter, stockAlertLimiter } from "./middlewares/rateLimiter";

const app: Express = express();

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
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : true; // Allow all in dev

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
app.use("/api", apiLimiter);
app.use("/api/newsletter", newsletterLimiter);
app.use("/api/stock-alerts", stockAlertLimiter);
app.use("/api/orders", checkoutLimiter);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api", smsWebhookRouter);
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
