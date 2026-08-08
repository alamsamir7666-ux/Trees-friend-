import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router = Router();

// CQ-3: removed dead `logAdminAction` export — it was a duplicate of
// lib/audit.ts's `logAudit` function (the one every callsite actually uses).
// Keeping it here caused confusion: "which audit function do I call?" — the
// answer is always `logAudit` from lib/audit.ts, which is the canonical
// implementation with the try/catch + logger fallback. This file now only
// owns the GET /admin/audit-logs read endpoint; writes go through lib/audit.ts.

router.get("/admin/audit-logs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    const logs = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(limit);

    res.json(
      logs.map((l) => ({
        id: l.id,
        adminId: l.adminId,
        adminEmail: l.adminEmail,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        before: l.before,
        after: l.after,
        createdAt: l.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "Route handler error");
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

export default router;
