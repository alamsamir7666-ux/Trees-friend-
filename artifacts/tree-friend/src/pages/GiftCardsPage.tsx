// artifacts/tree-friend/src/pages/GiftCardsPage.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, Copy, Check, Loader2, CreditCard } from "lucide-react";
import { useUser } from "@clerk/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";
import { updateSEO } from "@/lib/seo";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

updateSEO({
  title: "Gift Cards",
  description: "Send the gift of a greener home. Purchase a gift card for a friend or loved one.",
});

interface GiftCard {
  id: number;
  code: string;
  initialBalance: number;
  balance: number;
  isActive: boolean;
  recipientEmail: string | null;
  recipientName: string | null;
  message: string | null;
  expiryDate: string | null;
  createdAt: string;
}

const PRESET_AMOUNTS = [500, 1000, 2000, 5000];

async function fetchMyCards(): Promise<GiftCard[]> {
  const { data } = await apiClient.get<GiftCard[]>("/api/gift-cards/my");
  return data;
}

export function GiftCardsPage() {
  const { user } = useUser();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [amount, setAmount] = useState<number | "">("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [checkCode, setCheckCode] = useState("");
  const [checkedBalance, setCheckedBalance] = useState<number | null>(null);
  const [checkError, setCheckError] = useState("");

  const { data: myCards, isLoading } = useQuery({
    queryKey: ["my-gift-cards"],
    queryFn: fetchMyCards,
    enabled: !!user,
  });

  const purchase = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<GiftCard>("/api/gift-cards", { amount, recipientName, recipientEmail, message });
      return data;
    },
    onSuccess: (card) => {
      qc.invalidateQueries({ queryKey: ["my-gift-cards"] });
      toast({ title: `Gift card created! Code: ${card.code}` });
      setAmount("");
      setRecipientName("");
      setRecipientEmail("");
      setMessage("");
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  async function handleCheckBalance() {
    setCheckError("");
    setCheckedBalance(null);
    if (!checkCode.trim()) return;
    try {
      const r = await fetch(`/api/gift-cards/check/${checkCode.trim().toUpperCase()}`, { credentials: "include" });
      const d = await r.json();
      if (!r.ok) { setCheckError(d.error ?? "Not found"); return; }
      setCheckedBalance(d.balance);
    } catch {
      setCheckError("Something went wrong");
    }
  }

  return (
    <div className="container mx-auto px-4 py-12 max-w-4xl">
      <PageBreadcrumb crumbs={[{ label: "Gift Cards", icon: <Gift className="h-3 w-3" /> }]} className="mb-4" />
      <div className="mb-10">
        <p className="text-xs uppercase tracking-widest text-accent mb-1 font-medium">Give a Gift</p>
        <h1 className="font-serif text-3xl font-medium">Gift Cards</h1>
      </div>

      <div className="grid md:grid-cols-2 gap-10">
        {/* Purchase form */}
        <div className="space-y-6">
          <div className="bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-100 rounded-2xl p-6 flex items-center gap-4">
            <div className="h-12 w-12 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
              <Gift className="h-6 w-6 text-rose-500" />
            </div>
            <div>
              <p className="font-semibold text-sm">Send the gift of a greener home</p>
              <p className="text-xs text-muted-foreground mt-0.5">Valid for 1 year · No fees · Instant code delivery</p>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Amount (Tk)</label>
            <div className="grid grid-cols-4 gap-2 mb-3">
              {PRESET_AMOUNTS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAmount(a)}
                  className={`py-2 rounded-xl border text-sm font-medium transition-colors ${
                    amount === a
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border hover:border-accent/50"
                  }`}
                >
                  Tk{a.toLocaleString()}
                </button>
              ))}
            </div>
            <Input
              type="number"
              placeholder="Or enter custom amount (min Tk100)"
              value={amount}
              onChange={(e) => setAmount(e.target.value ? Number(e.target.value) : "")}
              min={100}
              max={50000}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Recipient's Name <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              placeholder="e.g. Nadia Rahman"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Recipient's Email <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="they@example.com"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Personal Message <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Wishing you a garden full of green! 🌿"
              rows={3}
              maxLength={300}
            />
          </div>

          <Button
            className="w-full rounded-full"
            size="lg"
            onClick={() => purchase.mutate()}
            disabled={!amount || Number(amount) < 100 || purchase.isPending || !user}
          >
            {purchase.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Creating?</>
            ) : (
              <><Gift className="h-4 w-4 mr-2" /> Purchase Gift Card</>
            )}
          </Button>
          {!user && (
            <p className="text-sm text-muted-foreground text-center">Sign in to purchase a gift card</p>
          )}
        </div>

        {/* Right: balance checker + my cards */}
        <div className="space-y-8">
          {/* Balance checker */}
          <div className="border rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <h3 className="font-medium">Check Balance</h3>
            </div>
            <div className="flex gap-2">
              <Input
                value={checkCode}
                onChange={(e) => setCheckCode(e.target.value.toUpperCase())}
                placeholder="ENVY-XXXX-XXXX-XXXX"
                className="font-mono text-sm"
              />
              <Button variant="outline" onClick={handleCheckBalance}>Check</Button>
            </div>
            {checkedBalance !== null && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                ? Available balance: <strong>Tk{checkedBalance.toLocaleString()}</strong>
              </p>
            )}
            {checkError && (
              <p className="text-sm text-red-600">{checkError}</p>
            )}
          </div>

          {/* My purchased cards */}
          {user && (
            <div>
              <h3 className="font-medium mb-3">Your Gift Cards</h3>
              {isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-20 rounded-xl" />
                  <Skeleton className="h-20 rounded-xl" />
                </div>
              ) : !myCards?.length ? (
                <p className="text-sm text-muted-foreground">You haven't purchased any gift cards yet.</p>
              ) : (
                <div className="space-y-3">
                  {myCards.map((card) => (
                    <div key={card.id} className="border rounded-xl p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <code className="text-sm font-mono font-medium tracking-wide">{card.code}</code>
                        <button
                          onClick={() => copyCode(card.code)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Copy code"
                        >
                          {copiedCode === card.code ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>Balance: <strong className="text-foreground">Tk{card.balance.toLocaleString()}</strong> / Tk{card.initialBalance.toLocaleString()}</span>
                        {card.recipientName && <span>For {card.recipientName}</span>}
                      </div>
                      {card.expiryDate && (
                        <p className="text-xs text-muted-foreground">
                          Expires {new Date(card.expiryDate).toLocaleDateString("en-BD", { day: "numeric", month: "short", year: "numeric" })}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
