// artifacts/tree-friend/src/pages/SubscriptionsPage.tsx
import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useUser } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { updateSEO } from "@/lib/seo";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { NoImagePlaceholder } from "@/components/ui/NoImagePlaceholder";
import {
  RefreshCw, Pause, Play, X, Package, ChevronRight, Plus, CalendarDays,
} from "lucide-react";

updateSEO({ title: "My Subscriptions", description: "Manage your recurring plant and tree orders." });

interface SubscriptionItem {
  productId: number;
  productName: string;
  productImage: string;
  quantity: number;
  price: number;
}

interface Subscription {
  id: number;
  status: "active" | "paused" | "cancelled";
  frequency: "weekly" | "biweekly" | "monthly";
  items: SubscriptionItem[];
  totalAmount: number;
  discountPercent: number;
  nextOrderDate: string;
  orderCount: number;
  paymentMethod: string;
  notes: string | null;
  createdAt: string;
}

const FREQ_LABEL: Record<string, string> = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  cancelled: "bg-red-100 text-red-800",
};

async function fetchSubscriptions(): Promise<Subscription[]> {
  const { data } = await apiClient.get<Subscription[]>("/api/subscriptions");
  return data;
}

async function patchSubscription(id: number, body: object): Promise<Subscription> {
  const { data } = await apiClient.patch<Subscription>(`/api/subscriptions/${id}`, body);
  return data;
}

export function SubscriptionsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editId, setEditId] = useState<number | null>(null);
  const [editFreq, setEditFreq] = useState<string>("monthly");

  const { data: subs, isLoading } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: fetchSubscriptions,
    enabled: !!user,
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) => patchSubscription(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      toast({ title: "Subscription updated" });
      setEditId(null);
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  if (!user) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted-foreground mb-4">Sign in to manage your subscriptions.</p>
        <Link href="/sign-in"><Button>Sign In</Button></Link>
      </div>
    );
  }

  const activeSubs = subs?.filter((s) => s.status !== "cancelled") ?? [];
  const cancelledSubs = subs?.filter((s) => s.status === "cancelled") ?? [];

  return (
    <div className="container mx-auto px-4 py-12 max-w-3xl">
      <PageBreadcrumb crumbs={[{ label: "My Subscriptions", icon: <RefreshCw className="h-3 w-3" /> }]} className="mb-4" />
      <div className="flex items-end justify-between mb-8">
        <div>
          <p className="text-xs uppercase tracking-widest text-accent mb-1 font-medium">Replenishment</p>
          <h1 className="font-serif text-3xl font-medium">My Subscriptions</h1>
        </div>
        <Link href="/products">
          <Button variant="outline" size="sm">
            <Plus className="h-4 w-4 mr-1.5" />
            Add Products
          </Button>
        </Link>
      </div>

      {/* How it works banner */}
      <div className="bg-accent/5 border border-accent/20 rounded-2xl p-5 mb-8 flex items-start gap-4">
        <RefreshCw className="h-5 w-5 text-accent shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-medium mb-1">Save 10% on every replenishment order</p>
          <p className="text-muted-foreground">Subscriptions automatically place an order at your chosen frequency. Pause or cancel any time.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : activeSubs.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium mb-1">No active subscriptions</p>
          <p className="text-sm mb-6">Add products to your cart and choose "Subscribe & Save" at checkout.</p>
          <Link href="/products"><Button>Shop Now</Button></Link>
        </div>
      ) : (
        <div className="space-y-4">
          {activeSubs.map((sub) => (
            <div key={sub.id} className="border rounded-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 bg-muted/30 border-b">
                <div className="flex items-center gap-3">
                  <Badge className={STATUS_COLORS[sub.status]}>{sub.status}</Badge>
                  <span className="text-sm text-muted-foreground">{FREQ_LABEL[sub.frequency]}</span>
                </div>
                <div className="flex gap-2">
                  {sub.status === "active" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => patch.mutate({ id: sub.id, body: { status: "paused" } })}
                      disabled={patch.isPending}
                    >
                      <Pause className="h-3.5 w-3.5 mr-1" /> Pause
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => patch.mutate({ id: sub.id, body: { status: "active" } })}
                      disabled={patch.isPending}
                    >
                      <Play className="h-3.5 w-3.5 mr-1" /> Resume
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={() => {
                      if (confirm("Cancel this subscription?")) {
                        patch.mutate({ id: sub.id, body: { status: "cancelled" } });
                      }
                    }}
                    disabled={patch.isPending}
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                </div>
              </div>

              {/* Items */}
              <div className="px-6 py-4 space-y-3">
                {sub.items.map((item) => (
                  <div key={item.productId} className="flex items-center gap-3">
                    {item.productImage ? (
                      <img
                        src={item.productImage}
                        alt={item.productName}
                        className="h-12 w-12 object-cover rounded-xl bg-muted"
                      />
                    ) : (
                      <NoImagePlaceholder className="h-12 w-12 rounded-xl shrink-0" compact />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">Qty: {item.quantity}</p>
                    </div>
                    <p className="text-sm font-medium">Tk{(item.price * item.quantity * (1 - sub.discountPercent / 100)).toFixed(0)}</p>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t bg-muted/20 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <CalendarDays className="h-4 w-4" />
                  <span>Next order: <strong className="text-foreground">{new Date(sub.nextOrderDate).toLocaleDateString("en-BD", { day: "numeric", month: "short", year: "numeric" })}</strong></span>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold">Tk{sub.totalAmount.toFixed(0)} <span className="text-green-600 text-xs font-normal">({sub.discountPercent}% off)</span></p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setEditId(sub.id); setEditFreq(sub.frequency); }}
                  >
                    Edit <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cancelled subs collapsed section */}
      {cancelledSubs.length > 0 && (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {cancelledSubs.length} cancelled subscription{cancelledSubs.length > 1 ? "s" : ""}
          </summary>
          <div className="mt-3 space-y-3 opacity-60">
            {cancelledSubs.map((sub) => (
              <div key={sub.id} className="border rounded-xl px-4 py-3 flex items-center gap-3">
                <Badge className={STATUS_COLORS.cancelled}>Cancelled</Badge>
                <span className="text-sm">{FREQ_LABEL[sub.frequency]}</span>
                <span className="text-sm text-muted-foreground ml-auto">{sub.items.length} item{sub.items.length > 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Edit frequency dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => !o && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Subscription</DialogTitle>
            <DialogDescription>Change how often we ship your replenishment order.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium mb-2 block">Delivery Frequency</label>
              <Select value={editFreq} onValueChange={setEditFreq}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Every week</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="monthly">Every month</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={() => editId && patch.mutate({ id: editId, body: { frequency: editFreq } })}
                disabled={patch.isPending}
                className="flex-1"
              >
                Save Changes
              </Button>
              <Button variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
