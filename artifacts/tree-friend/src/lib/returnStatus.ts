/**
 * Shared return-status badge configuration.
 *
 * Used by both OrdersPage.tsx (list view) and OrderDetailPage.tsx (detail
 * view) so the return status labels and colors stay consistent across
 * both surfaces. Previously each file had its own copy of this config
 * with slightly different shapes — `returnBadgeColors` +
 * `returnBadgeLabels` (two separate maps) in OrdersPage, and
 * `returnStatusConfig` (one map with {label, color, bg}) in
 * OrderDetailPage. The two could drift apart silently. This module is
 * the single source of truth.
 *
 * The return statuses match the `returnStatusEnum` in
 * lib/db/src/schema/returns.ts: ["requested", "approved", "rejected",
 * "completed"]. If a new status is added there, add it here too.
 */

export interface ReturnStatusConfig {
  /** Human-readable label shown in the badge. */
  label: string;
  /** Tailwind text color class for the badge text + icon. */
  color: string;
  /** Tailwind background classes for the badge itself. */
  badgeBg: string;
  /** Tailwind background classes for the full-width banner (detail page). */
  bannerBg: string;
}

export const returnStatusConfig: Record<string, ReturnStatusConfig> = {
  requested: {
    label: "Return Requested",
    color: "text-warning-foreground",
    badgeBg: "bg-warning text-warning-foreground",
    bannerBg: "bg-warning border-warning-border",
  },
  approved: {
    label: "Return Approved",
    color: "text-info-foreground",
    badgeBg: "bg-info text-info-foreground",
    bannerBg: "bg-info border-info-border",
  },
  rejected: {
    label: "Return Rejected",
    color: "text-destructive",
    badgeBg: "bg-destructive/10 text-destructive",
    bannerBg: "bg-destructive/10 border-destructive/20",
  },
  completed: {
    label: "Refund Completed",
    color: "text-success-foreground",
    badgeBg: "bg-success text-success-foreground",
    bannerBg: "bg-success border-success-border",
  },
};

/**
 * Returns the config for a return status, falling back to a generic
 * "unknown" config if the status isn't in the map (e.g. a new status
 * was added server-side before this file was updated). The fallback
 * ensures the UI never crashes on an unknown status — it just shows a
 * neutral badge.
 */
export function getReturnStatusConfig(status: string): ReturnStatusConfig {
  return (
    returnStatusConfig[status] ?? {
      label: status.charAt(0).toUpperCase() + status.slice(1),
      color: "text-muted-foreground",
      badgeBg: "bg-muted text-muted-foreground",
      bannerBg: "bg-muted/30 border-border",
    }
  );
}
