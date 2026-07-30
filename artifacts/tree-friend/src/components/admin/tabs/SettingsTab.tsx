import { useState } from "react";
import { Store, Mail, Coins, CreditCard, Settings, Globe, Truck, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsTab() {
  const [storeName, setStoreName] = useState(() => localStorage.getItem("admin_storeName") || "Tree Friend");
  const [supportEmail, setSupportEmail] = useState(() => localStorage.getItem("admin_supportEmail") || "hello@treefriend.com");
  const [saved, setSaved] = useState<string | null>(null);

  function handleSave(field: string, value: string) {
    localStorage.setItem(`admin_${field}`, value);
    setSaved(field);
    setTimeout(() => setSaved(null), 2000);
  }

  const storeSettings = [
    {
      icon: Store,
      label: "Store Name",
      desc: "Displayed in the header, emails, and order confirmations",
      value: storeName,
      field: "storeName",
      editable: true,
      onChange: setStoreName,
    },
    {
      icon: Mail,
      label: "Support Email",
      desc: "Customers will see this address for support inquiries",
      value: supportEmail,
      field: "supportEmail",
      editable: true,
      onChange: setSupportEmail,
    },
    {
      icon: Coins,
      label: "Currency",
      desc: "Bangladeshi Taka — the primary currency for all transactions",
      value: "BDT (Tk)",
      editable: false,
    },
    {
      icon: CreditCard,
      label: "Payment Methods",
      desc: "Enabled at checkout for customers",
      value: "bKash, Cash on Delivery",
      editable: false,
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
          {storeSettings.map(({ icon: Icon, label, desc, value, field, editable, onChange }) => (
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
                    {editable && saved === field && (
                      <span className="text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Saved</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{desc}</p>
                  {editable ? (
                    <div className="flex items-center gap-2 overflow-hidden">
                      <input
                        type={field === "supportEmail" ? "email" : "text"}
                        value={value}
                        onChange={(e) => onChange?.(e.target.value)}
                        className="flex-1 min-w-0 h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <button
                        onClick={() => handleSave(field!, value!)}
                        className="h-9 px-4 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-foreground bg-muted/40 rounded-lg px-3 py-2 inline-block">
                      {value}
                    </p>
                  )}
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
