// artifacts/tree-friend/src/components/ui/OrderTimeline.tsx
// Drop into OrderDetailPage.tsx - replaces the static progress bar.
// Reads statusTimeline from the order object (added via migration).
import { memo } from "react";
import { CheckCircle2, Circle, Package, Truck, Home, Clock, XCircle } from "lucide-react";

interface TimelineEvent {
  status: string;
  timestamp: string;
  note?: string | null;
}

interface OrderTimelineProps {
  currentStatus: string;
  timeline?: TimelineEvent[];
}

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"] as const;

const STEP_META: Record<string, { label: string; icon: React.ElementType; description: string }> = {
  pending: {
    label: "Order Placed",
    icon: Clock,
    description: "Your order has been received and is awaiting confirmation.",
  },
  confirmed: {
    label: "Confirmed",
    icon: CheckCircle2,
    description: "Payment verified and order is confirmed.",
  },
  processing: {
    label: "Processing",
    icon: Package,
    description: "Your items are being packed and prepared for shipment.",
  },
  shipped: {
    label: "Shipped",
    icon: Truck,
    description: "Your order is on its way.",
  },
  delivered: {
    label: "Delivered",
    icon: Home,
    description: "Package delivered successfully.",
  },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const OrderTimeline = memo(function OrderTimeline({ currentStatus, timeline = [] }: OrderTimelineProps) {
  const isCancelled = currentStatus === "cancelled";
  const currentStepIndex = STEPS.indexOf(currentStatus as (typeof STEPS)[number]);

  // Build a map from status ? timeline event (for timestamps/notes)
  const eventMap = new Map<string, TimelineEvent>();
  for (const event of timeline) {
    eventMap.set(event.status, event);
  }

  if (isCancelled) {
    const cancelEvent = eventMap.get("cancelled");
    return (
      <div className="border rounded-2xl overflow-hidden mb-8">
        <div className="px-6 py-4 bg-muted/30 border-b">
          <h3 className="font-medium text-sm">Order Status</h3>
        </div>
        <div className="px-6 py-6 flex items-center gap-4">
          <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
            <XCircle className="h-6 w-6 text-destructive" />
          </div>
          <div>
            <p className="font-semibold text-destructive">Order Cancelled</p>
            {cancelEvent && (
              <p className="text-xs text-muted-foreground mt-0.5">{formatDate(cancelEvent.timestamp)}</p>
            )}
            {cancelEvent?.note && (
              <p className="text-sm text-muted-foreground mt-1">Reason: {cancelEvent.note}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-2xl overflow-hidden mb-8">
      <div className="px-6 py-4 bg-muted/30 border-b">
        <h3 className="font-medium text-sm">Order Timeline</h3>
      </div>
      <div className="px-6 py-6">
        <ol className="relative space-y-0">
          {STEPS.map((step, index) => {
            const meta = STEP_META[step];
            const Icon = meta.icon;
            const isDone = index <= currentStepIndex;
            const isCurrent = index === currentStepIndex;
            const event = eventMap.get(step);
            const isLast = index === STEPS.length - 1;

            return (
              <li key={step} className="flex gap-4">
                {/* Icon + line */}
                <div className="flex flex-col items-center">
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                      isDone
                        ? isCurrent
                          ? "bg-accent text-accent-foreground ring-4 ring-accent/20"
                          : "bg-success-foreground text-success"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDone && !isCurrent ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Icon className="h-4 w-4" />
                    )}
                  </div>
                  {!isLast && (
                    <div
                      className={`w-0.5 flex-1 mt-1 mb-1 min-h-[2rem] rounded-full transition-colors ${
                        isDone && index < currentStepIndex ? "bg-success-foreground/70" : "bg-border"
                      }`}
                    />
                  )}
                </div>

                {/* Content */}
                <div className={`pb-6 ${isLast ? "pb-0" : ""} flex-1 min-w-0 pt-1`}>
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <p
                      className={`text-sm font-medium ${
                        isCurrent ? "text-accent" : isDone ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {meta.label}
                      {isCurrent && (
                        <span className="ml-2 text-xs font-normal bg-accent/10 text-accent px-2 py-0.5 rounded-full">
                          Current
                        </span>
                      )}
                    </p>
                    {event?.timestamp && (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(event.timestamp)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {event?.note ?? meta.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
});
