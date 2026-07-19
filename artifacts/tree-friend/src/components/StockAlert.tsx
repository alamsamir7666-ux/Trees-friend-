import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiClient } from "@/lib/apiClient";
import { useUser } from "@clerk/react";

export function StockAlert({ productId }: { productId: number }) {
  const { user } = useUser();
  const { toast } = useToast();
  const [email, setEmail] = useState(
    (user?.primaryEmailAddress?.emailAddress ?? "")
  );
  const [loading, setLoading] = useState(false);
  const [subscribed, setSubscribed] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !email.includes("@")) return;
    setLoading(true);
    try {
      await apiClient.post("/api/stock-alerts", { productId, email });
      setSubscribed(true);
      toast({
        title: "Alert set!",
        description: "We'll email you when this product is back in stock.",
      });
    } catch (err: any) {
      toast({
        title: "Failed",
        description: err?.response?.data?.error ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  if (subscribed) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm font-medium py-2">
        <Check className="h-4 w-4" />
        You'll be notified when this is back in stock
      </div>
    );
  }

  return (
    <div className="border border-dashed border-border rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Bell className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium">Notify me when back in stock</span>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="rounded-xl text-sm"
          required
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={loading}
          className="rounded-xl shrink-0"
        >
          {loading ? "..." : "Notify Me"}
        </Button>
      </form>
    </div>
  );
}
