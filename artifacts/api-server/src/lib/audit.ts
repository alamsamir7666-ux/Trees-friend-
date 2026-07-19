import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";

export async function logAudit({
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
  targetId?: string;
  before?: any;
  after?: any;
}) {
  try {
    await db.insert(auditLogsTable).values({
      adminId,
      adminEmail: adminEmail ?? null,
      action,
      targetType: targetType ?? null,
      targetId: targetId ? String(targetId) : null,
      before: before ?? null,
      after: after ?? null,
    });
  } catch (e) {
    // Never let audit logging break the main action
    console.error("Audit log failed:", e);
  }
}
