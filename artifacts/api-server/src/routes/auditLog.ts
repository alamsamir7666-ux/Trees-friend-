import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

export async function logAdminAction({
  adminId,
  adminEmail,
  action,
  targetType,
  targetId,
  before,
  after,
}: {
  adminId: string;
  adminEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string | number;
  before?: unknown;
  after?: unknown;
}) {
  try {
    await db.insert(auditLogsTable).values({
      adminId,
      adminEmail: adminEmail ?? null,
      action,
      targetType: targetType ?? null,
      targetId: targetId != null ? String(targetId) : null,
      before: before ?? null,
      after: after ?? null,
    });
  } catch (err) {
    console.error("[audit] Failed to log action:", err);
  }
}

router.get("/admin/audit-logs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? "50"));
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
  } catch {
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

export default router;
