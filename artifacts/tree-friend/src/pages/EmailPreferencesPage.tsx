// artifacts/tree-friend/src/pages/EmailPreferencesPage.tsx
// Add route in App.tsx: <Route path="/email-preferences" component={EmailPreferencesPage} />
// Also link from ProfilePage.tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, ShoppingBag, Tag, Package, RotateCcw, Star, Loader2, Check } from "lucide-react";
import { useUser } from "@clerk/react";
import { Link } from "wouter";
import { apiClient } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { updateSEO } from "@/lib/seo";

updateSEO({ title: "Email Preferences", description: "Manage which emails you receive from Tree Friend." });

interface EmailPrefs {
  orderUpdates: boolean;
  promotions: boolean;
  restockAlerts: boolean;
  newsletter: boolean;
  abandonedCart: boolean;
  loyaltyUpdates: boolean;
  updatedAt: string | null;
}

const PREF_META = [
  {
    key: "orderUpdates" as keyof EmailPrefs,
    label: "Order Updates",
    description: "Confirmations, shipping notifications, and delivery status.",
    icon: ShoppingBag,
    canDisable: false, // transactional - always on
  },
  {
    key: "promotions" as keyof EmailPrefs,
    label: "Promotions & Sales",
    description: "Flash sales, seasonal discounts, and exclusive member offers.",
    icon: Tag,
    canDisable: true,
  },
  {
    key: "restockAlerts" as keyof EmailPrefs,
    label: "Back In Stock Alerts",
    description: "Notified when items on your watchlist are available again.",
    icon: Package,
    canDisable: true,
  },
  {
    key: "newsletter" as keyof EmailPrefs,
    label: "Plant Care Newsletter",
    description: "Tips, growing guides, seasonal advice and new arrivals.",
    icon: Bell,
    canDisable: true,
  },
  {
    key: "abandonedCart" as keyof EmailPrefs,
    label: "Cart Reminders",
    description: "Friendly reminders when you've left items in your cart.",
    icon: RotateCcw,
    canDisable: true,
  },
  {
    key: "loyaltyUpdates" as keyof EmailPrefs,
    label: "Loyalty & Rewards",
    description: "Points earned, tier upgrades, and redemption reminders.",
    icon: Star,
    canDisable: true,
  },
];

export function EmailPreferencesPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<EmailPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    apiClient.get<EmailPrefs>("/api/email-preferences")
      .then(({ data }) => setPrefs(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user]);

  async function handleSave() {
    if (!prefs) return;
    setSaving(true);
    try {
      await apiClient.put("/api/email-preferences", prefs);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      toast({ title: "Failed to save preferences", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof EmailPrefs) {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: !prefs[key] });
  }

  if (!user) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted-foreground mb-4">Sign in to manage your email preferences.</p>
        <Link href="/sign-in"><Button>Sign In</Button></Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-12 max-w-2xl">
      <div className="mb-8">
        <Link href="/profile">
          <span className="text-sm text-muted-foreground hover:text-foreground transition-colors">← Back to Profile</span>
        </Link>
        <h1 className="font-serif text-3xl font-medium mt-4">Email Preferences</h1>
        <p className="text-muted-foreground mt-1 text-sm">Choose what you hear about from us.</p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : !prefs ? (
        <p className="text-muted-foreground text-center py-10">Failed to load preferences.</p>
      ) : (
        <div className="space-y-3">
          {PREF_META.map(({ key, label, description, icon: Icon, canDisable }) => (
            <div
              key={key}
              className={`flex items-center gap-4 border rounded-2xl px-5 py-4 transition-colors ${
                !canDisable ? "bg-muted/30 opacity-75" : "bg-card"
              }`}
            >
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
                {!canDisable && (
                  <p className="text-xs text-muted-foreground/60 mt-0.5 italic">Required for your account</p>
                )}
              </div>
              <Switch
                checked={!!prefs[key]}
                onCheckedChange={() => canDisable && toggle(key)}
                disabled={!canDisable}
                aria-label={`Toggle ${label}`}
              />
            </div>
          ))}

          <div className="pt-4">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full rounded-full"
              size="lg"
            >
              {saving ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving?</>
              ) : saved ? (
                <><Check className="h-4 w-4 mr-2 text-green-300" /> Saved!</>
              ) : (
                "Save Preferences"
              )}
            </Button>
            <p className="text-xs text-center text-muted-foreground mt-3">
              Changes take effect immediately for future emails.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
