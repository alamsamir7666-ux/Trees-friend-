import { useState } from "react";
import { Mail, Check } from "lucide-react";
import { apiClient } from "@/lib/apiClient";
import { useToast } from "@/hooks/use-toast";

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !email.includes("@")) return;
    setLoading(true);
    try {
      await apiClient.post("/api/newsletter/subscribe", { email });
      setDone(true);
      setEmail("");
      toast({ title: "Subscribed!", description: "Thank you for joining our community." });
    } catch {
      toast({ title: "Failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center gap-2 text-sm text-background/80">
        <Check className="h-4 w-4 text-green-400" />
        You're subscribed! Thank you.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2" noValidate>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Your email address"
        aria-label="Email address for newsletter"
        required
        className="bg-transparent border border-background/30 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:border-accent transition-colors text-background placeholder:text-background/50"
      />
      <button
        type="submit"
        disabled={loading || !email}
        className="bg-accent text-accent-foreground px-4 py-2 text-sm font-medium hover:bg-accent/90 transition-colors rounded-lg whitespace-nowrap disabled:opacity-60"
      >
        {loading ? "..." : "Join"}
      </button>
    </form>
  );
}
