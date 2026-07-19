import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useTrackOrder, getTrackOrderQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Package, Truck, Home, Circle } from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

const STEPS = ["pending", "confirmed", "processing", "shipped", "delivered"];
const stepIcons = [Circle, CheckCircle2, Package, Truck, Home];

export function TrackOrderPage() {
  const params = useParams<{ trackingId?: string }>();
  const [code, setCode] = useState(params.trackingId ?? "");
  const [submitted, setSubmitted] = useState(params.trackingId ?? "");

  useEffect(() => {
    if (params.trackingId) {
      setCode(params.trackingId);
      setSubmitted(params.trackingId);
    }
  }, [params.trackingId]);

  const [, setLocation] = useLocation();
  useEffect(() => {
    if (submitted && submitted.startsWith("PRE-")) {
      setLocation("/pre-orders/" + submitted);
    }
  }, [submitted]);

  const { data: order, isLoading, isError } = useTrackOrder(submitted, {
    query: { enabled: !!submitted, retry: false, queryKey: getTrackOrderQueryKey(submitted) },
  });

  const currentStep = order ? STEPS.indexOf(order.orderStatus) : -1;

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-muted/30 border-b py-10">
        <div className="container mx-auto px-4">
          <PageBreadcrumb crumbs={[{ label: "Track Order", icon: <Truck className="h-3 w-3" /> }]} className="mb-3" />
          <p className="text-xs uppercase tracking-[0.15em] text-accent-text mb-2 font-medium">Order Tracking</p>
          <h1 className="font-serif text-4xl font-medium">Track Your Order</h1>
        </div>
      </div>

      <div className="container mx-auto px-4 py-12 max-w-lg">
        <div className="bg-card border rounded-xl p-6 mb-6">
          <p className="text-sm text-muted-foreground mb-4">Enter your tracking ID to see your delivery status.</p>
          <div className="flex gap-3">
            <Input
              placeholder="e.g. TRK-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="flex-1"
              onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) setSubmitted(code.trim()); }}
            />
            <Button
              onClick={() => setSubmitted(code.trim())}
              disabled={!code.trim() || isLoading}
            >
              Track
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-center text-muted-foreground">Searching...</p>}
        {isError && submitted && (
          <div className="bg-destructive/10 text-destructive rounded-xl p-4 text-sm text-center">
            Order not found. Please check your tracking ID and try again.
          </div>
        )}

        {order && (
          <div className="space-y-5">
            <div className="bg-card border rounded-xl p-6">
              <div className="flex justify-between items-start mb-5">
                <div>
                  <p className="font-medium font-mono text-sm text-muted-foreground">{order.trackingId}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{new Date(order.createdAt).toLocaleDateString("en-BD", { year: "numeric", month: "long", day: "numeric" })}</p>
                </div>
                <span className="text-sm font-medium capitalize px-3 py-1 rounded-full bg-muted">{order.orderStatus}</span>
              </div>

              {order.orderStatus !== "cancelled" ? (
                <div className="flex items-start gap-0">
                  {STEPS.map((step, i) => {
                    const done = i < currentStep;
                    const active = i === currentStep;
                    const Icon = stepIcons[Math.min(i, stepIcons.length - 1)];
                    return (
                      <div key={step} className="flex-1 flex flex-col items-center relative">
                        {i < STEPS.length - 1 && (
                          <div className={`absolute top-5 left-1/2 w-full h-0.5 ${done ? "bg-accent" : "bg-border"}`} />
                        )}
                        <div className={`relative z-10 h-10 w-10 rounded-full flex items-center justify-center border-2 transition-colors ${done ? "bg-accent border-accent" : active ? "bg-background border-primary" : "bg-background border-border text-muted-foreground"}`}>
                          {done ? <CheckCircle2 className="h-5 w-5 text-white" /> : <Icon className="h-5 w-5" />}
                        </div>
                        <p className={`text-xs mt-2 capitalize text-center ${active ? "font-medium" : "text-muted-foreground"}`}>{step}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-red-50 text-red-600 rounded-lg p-3 text-sm text-center">
                  This order has been cancelled.
                </div>
              )}
            </div>

            {/* Timeline events */}
            {order.timeline && order.timeline.length > 0 && (
              <div className="bg-card border rounded-xl p-5">
                <h3 className="font-medium text-sm mb-4">Tracking Timeline</h3>
                <div className="space-y-3">
                  {order.timeline.map((event, i) => (
                    <div key={i} className={`flex gap-3 text-sm ${event.completed ? "" : "opacity-50"}`}>
                      <div className={`mt-0.5 h-4 w-4 rounded-full shrink-0 flex items-center justify-center ${event.completed ? "bg-accent" : "bg-border"}`}>
                        {event.completed && <CheckCircle2 className="h-3 w-3 text-white" />}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium capitalize">{event.label}</p>
                        {event.timestamp && (
                          <p className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {order.items && order.items.length > 0 && (
              <div className="bg-card border rounded-xl p-5">
                <h3 className="font-medium text-sm mb-4">Items Ordered</h3>
                <div className="space-y-3">
                  {order.items.map((item, i) => (
                    <div key={i} className="flex items-center gap-3">
                      {item.productImage && (
                        <img src={item.productImage} alt={item.productName} className="h-12 w-12 rounded-lg object-cover border shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.productName}</p>
                        <p className="text-xs text-muted-foreground">{item.variantName} · Qty: {item.quantity} · Tk{Number(item.price).toLocaleString()}</p>
                      </div>
                      <p className="text-sm font-semibold shrink-0">Tk{(item.price * item.quantity).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
                {order.totalAmount != null && (
                  <div className="border-t mt-4 pt-3 space-y-1.5">
                    {order.subtotal != null && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span>Tk{Number(order.subtotal).toLocaleString()}</span>
                      </div>
                    )}
                    {order.discountAmount > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Discount</span>
                        <span className="text-green-600">-Tk{Number(order.discountAmount).toLocaleString()}</span>
                      </div>
                    )}
                    {order.subtotal != null && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Delivery</span>
                        <span>
                          {(Number(order.totalAmount) - Number(order.subtotal) + Number(order.discountAmount ?? 0)) === 0
                            ? <span className="text-green-600">Free</span>
                            : `Tk${(Number(order.totalAmount) - Number(order.subtotal) + Number(order.discountAmount ?? 0)).toLocaleString()}`}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm font-semibold border-t pt-1.5 mt-1.5">
                      <span>Total</span>
                      <span>Tk{Number(order.totalAmount).toLocaleString()}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="bg-card border rounded-xl p-5">
              <h3 className="font-medium text-sm mb-3">Payment</h3>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground capitalize">{order.paymentMethod}</span>
                <span className="font-semibold capitalize">{order.paymentStatus}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
