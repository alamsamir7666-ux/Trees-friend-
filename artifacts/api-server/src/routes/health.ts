import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/health", async (_req, res) => {
  const start = Date.now();
  try {
    // Quick DB ping to verify connectivity
    await db.execute(sql`SELECT 1`);
    const dbLatency = Date.now() - start;

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      db: { status: "ok", latencyMs: dbLatency },
      version: process.env.npm_package_version ?? "unknown",
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      timestamp: new Date().toISOString(),
      db: { status: "error" },
    });
  }
});

export default router;
