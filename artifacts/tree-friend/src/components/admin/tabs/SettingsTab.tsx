import { Store, Mail, Coins, CreditCard, Settings, Globe, Truck, ShieldCheck } from "lucide-react";

/**
 * Admin "Settings" tab.
 *
 * Previously this tab had editable Store Name / Support Email inputs
 * whose "Save" buttons called `localStorage.setItem` — the value
 * persisted only in the current admin's browser and was never sent to
 * the backend, so it had zero effect on emails, the header, or order
 * confirmations. The "Saved ✓" pill was misleading.
 *
 * Fix: render all settings as read-only display rows that document
 * where each value is actually managed (env var on Render, another
 * admin tab, seller dashboard, etc.). No fake inputs, no fake save
 * buttons. If a setting genuinely needs to be editable from the admin
 * UI, it should be backed by a real `/api/admin/settings` route —
 * which doesn't exist yet, so we don't pretend it does.
 */
export function SettingsTab() {
  const storeSettings = [
    {
      icon: Store,
      label: "Store Name",
      desc: "Displayed in the header, emails, and order confirmations",
      value: "Tree Friend",
      managedIn: "Backend env var (Render)",
    },
    {
      icon: Mail,
      label: "Support Email",
      desc: "Customers will see this address for support inquiries",
      value: "hello@treefriend.com",
      managedIn: "Backend env var (Render)",
    },
    {
      icon: Coins,
      label: "Currency",
      desc: "Bangladeshi Taka — the primary currency for all transactions",
      value: "BDT (Tk)",
      managedIn: "Hardcoded (single-marketplace)",
    },
    {
      icon: CreditCard,
      label: "Payment Methods",
      desc: "Enabled at checkout for customers",
      value: "bKash, Cash on Delivery",
      managedIn: "Backend code + platform payment config",
    },
  ];

  const platformLinks = [
    {
      icon: Globe,
      label: "Store Name / Support Email / Payment Methods",
      desc: "Backend env vars on Render",
    },
    {
      icon: ShieldCheck,
      label: "Seller Payment Configs (bKash credentials)",
      desc: "Sellers tab → expand seller → Payment settings",
    },
    {
      icon: CreditCard,
      label: "Categories & Their Icons",
      desc: "Categories tab",
    },
    {
      icon: Truck,
      label: "Homepage Sections (Trending / New Arrivals)",
      desc: "Homepage Sections tab",
    },
  ];

  return (
    <div className="max-w-3xl space-y-8">
      {/* Store Settings */}
      <div>
        <div className="flex items-center gap-2.5 mb-5">
          <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Settings className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Store Settings</h3>
            <p className="text-[11px] text-muted-foreground">Core configuration for your marketplace</p>
          </div>
        </div>

        <div className="space-y-3">
          {storeSettings.map(({ icon: Icon, label, desc, value, managedIn }) => (
            <div
              key={label}
              className="rounded-2xl border border-border bg-card p-5 transition-shadow hover:shadow-sm"
            >
              <div className="flex items-start gap-4 overflow-hidden">
                <div className="h-10 w-10 rounded-xl bg-muted/60 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon className="h-4.5 w-4.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <p className="text-sm font-semibold text-foreground">{label}</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{desc}</p>
                  <p className="text-sm font-medium text-foreground bg-muted/40 rounded-lg px-3 py-2 inline-block">
                    {value}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Managed in: <span className="font-medium text-foreground/80">{managedIn}</span>
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Where to Manage Settings */}
      <div>
        <div className="flex items-center gap-2.5 mb-5">
          <div className="h-8 w-8 rounded-lg bg-accent/10 flex items-center justify-center">
            <Globe className="h-4 w-4 text-accent" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Where to Manage Settings</h3>
            <p className="text-[11px] text-muted-foreground">Some settings are managed in other admin tabs or backend</p>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-accent/5 p-5">
          <div className="space-y-3">
            {platformLinks.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-start gap-3">
                <div className="h-7 w-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon className="h-3.5 w-3.5 text-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
