import { useState } from "react";
import { Bell, Check, Loader2, Mail, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useUser } from "@clerk/react";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

interface Props {
  productId: number;
  productName: string;
  sheetMode?: boolean;
}

interface FormProps {
  method: "email" | "phone";
  setMethod: (m: "email" | "phone") => void;
  status: "idle" | "loading" | "success" | "error";
  phone: string;
  setPhone: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  handleSubmit: (e: React.FormEvent) => void;
  errorMsg: string;
}

function FormContent({ method, setMethod, status, phone, setPhone, email, setEmail, handleSubmit, errorMsg }: FormProps) {
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setMethod("phone")}
          style={{
            background: method === "phone" ? "hsl(var(--primary))" : "transparent",
            color: method === "phone" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
            border: method === "phone" ? "2px solid hsl(var(--primary))" : "2px solid hsl(var(--border))",
            borderRadius: 999,
            padding: "8px 18px",
            fontWeight: 500,
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <Phone size={15} /> Phone
        </button>
        <button
          type="button"
          onClick={() => setMethod("email")}
          style={{
            background: method === "email" ? "hsl(var(--primary))" : "transparent",
            color: method === "email" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
            border: method === "email" ? "2px solid hsl(var(--primary))" : "2px solid hsl(var(--border))",
            borderRadius: 999,
            padding: "8px 18px",
            fontWeight: 500,
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <Mail size={15} /> Email
        </button>
      </div>

      {status === "success" ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "16px 0", textAlign: "center" }}>
          <div style={{ height: 48, width: 48, borderRadius: "50%", background: "#dcfce7", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Check size={24} color="#16a34a" />
          </div>
          <p style={{ fontSize: 14, color: "#6b7280" }}>We'll notify you when back in stock!</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
          {method === "phone" ? (
            <input
              type="tel"
              placeholder="01XXXXXXXXX"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              style={{ flex: 1, borderRadius: 999, border: "1px solid hsl(var(--border))", padding: "10px 16px", fontSize: 14, outline: "none" }}
            />
          ) : (
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              style={{ flex: 1, borderRadius: 999, border: "1px solid hsl(var(--border))", padding: "10px 16px", fontSize: 14, outline: "none" }}
            />
          )}
          <button
            type="submit"
            disabled={status === "loading"}
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", border: "none", borderRadius: 999, padding: "10px 20px", fontWeight: 700, fontSize: 14, cursor: "pointer", flexShrink: 0 }}
          >
            {status === "loading" ? "..." : "Notify Me"}
          </button>
        </form>
      )}
      {status === "error" && <p style={{ fontSize: 12, color: "#ef4444" }}>{errorMsg}</p>}
    </div>
  );
}


export function StockAlertButton({ productId, productName, sheetMode }: Props) {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<"email" | "phone">("phone");
  const [email, setEmail] = useState(user?.primaryEmailAddress?.emailAddress ?? "");
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (method === "email" && !email.includes("@")) return;
    if (method === "phone" && phone.length < 8) return;
    setStatus("loading");
    try {
      const r = await fetch(API + "/api/stock-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, email: method === "email" ? email : `${phone}@phone.notify` }),
      });
      const data = await r.json();
      if (!r.ok) { setErrorMsg(data.error ?? "Failed"); setStatus("error"); return; }
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Something went wrong. Please try again.");
    }
  }

  const fp: FormProps = { method, setMethod, status, phone, setPhone, email, setEmail, handleSubmit, errorMsg };

  if (sheetMode) return <FormContent {...fp} />;

  return (
    <>
      <Button variant="outline" size="sm" className="w-full rounded-full gap-2" onClick={() => setOpen(true)}>
        <Bell className="h-4 w-4" /> Notify Me When Available
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Get Notified</DialogTitle>
            <DialogDescription>We'll notify you when <strong>{productName}</strong> is back in stock.</DialogDescription>
          </DialogHeader>
          <FormContent {...fp} />
        </DialogContent>
      </Dialog>
    </>
  );
}
