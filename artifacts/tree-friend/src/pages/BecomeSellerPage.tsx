import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@clerk/react";
import { Sprout, Loader2, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { updateSEO } from "@/lib/seo";
import { useGetMySeller, useBecomeSeller, getGetMySellerQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

updateSEO({ title: "Become a Seller", noIndex: true });

const EMPTY = {
  businessName: "",
  nurseryName: "",
  ownerName: "",
  contactPhone: "",
  contactEmail: "",
  location: "",
  description: "",
};

/**
 * Plan doc §5.1-2: new users choose Seller at signup, existing users see
 * "Become a Seller" from their profile. This page covers the "existing
 * user" path -- the signup-time choice is a separate, smaller addition to
 * the sign-up flow (not built here; Clerk owns account creation itself,
 * and there's no natural hook into that step without customizing Clerk's
 * sign-up UI, which is out of scope for this page).
 *
 * nidOrTradeLicenseUrl and nurseryImages (document/photo uploads) are
 * intentionally NOT collected in this first version of the form -- the
 * upload endpoint (POST /sellers/upload-verification-doc) exists and
 * works, but wiring a multi-file upload UI here is more surface area than
 * the core "create a pending_verification seller row" flow needs to ship
 * first. A seller can apply now and add documents from their dashboard
 * once §4's Business Verification tab is built.
 */
/**
 * The actual seller-application UI: status card if already applied, form if
 * not. No outer page container/breadcrumb -- those are added by whichever
 * caller renders this (the standalone /become-seller route, or inline as a
 * tab on the Profile page).
 */
export function BecomeSellerContent() {
  const qc = useQueryClient();
  const { isSignedIn } = useAuth();
  const { data: seller, isLoading } = useGetMySeller({
    query: { enabled: isSignedIn, queryKey: getGetMySellerQueryKey() },
  });
  const becomeSeller = useBecomeSeller();
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.businessName.trim() || !form.nurseryName.trim() || !form.ownerName.trim() ||
        !form.contactPhone.trim() || !form.contactEmail.trim() || !form.location.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    setSubmitting(true);
    becomeSeller.mutate(
      { data: { ...form, description: form.description.trim() || undefined } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetMySellerQueryKey() });
          toast.success("Application submitted! We'll review it shortly.");
          setSubmitting(false);
        },
        onError: (err: any) => {
          toast.error(err?.message ?? "Failed to submit application");
          setSubmitting(false);
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="py-16 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Already applied -- show status instead of the form.
  if (seller) {
    const statusMap: Record<string, { icon: React.ElementType; color: string; title: string; body: string }> = {
      pending_verification: {
        icon: Clock,
        color: "text-amber-600 bg-amber-50 border-amber-200",
        title: "Application under review",
        body: "We're reviewing your documents. You'll be notified once your seller account is approved.",
      },
      active: {
        icon: CheckCircle2,
        color: "text-emerald-600 bg-emerald-50 border-emerald-200",
        title: "You're an approved seller",
        body: "Your seller account is active. Head to your seller dashboard to start listing.",
      },
      suspended: {
        icon: XCircle,
        color: "text-red-600 bg-red-50 border-red-200",
        title: "Account suspended",
        body: "Your seller account is currently suspended. Contact support for more information.",
      },
      vacation: {
        icon: Clock,
        color: "text-blue-600 bg-blue-50 border-blue-200",
        title: "Vacation mode",
        body: "Your listings are hidden while you're on vacation mode. Turn it off from your seller dashboard to go live again.",
      },
    };
    const info = statusMap[seller.status] ?? statusMap.pending_verification;
    const Icon = info.icon;
    return (
      <div className={`rounded-2xl border p-6 ${info.color}`}>
        <Icon className="h-8 w-8 mb-3" />
        <h1 className="font-serif text-xl font-medium mb-1">{info.title}</h1>
        <p className="text-sm opacity-90">{info.body}</p>
        {seller.status === "active" && (
          <Link href="/seller/dashboard">
            <Button className="mt-4 rounded-full">Go to Seller Dashboard</Button>
          </Link>
        )}
      </div>
    );
  }

  // Never applied -- show the form.
  return (
    <div>
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-medium flex items-center gap-2">
          <Sprout className="h-6 w-6 text-accent" />
          Become a Seller
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          List your nursery's trees and plants on Tree Friend. First 6 months free, then ৳500/year — no commission, ever.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 bg-card border rounded-2xl p-6">
        <div>
          <Label htmlFor="businessName">Business Name *</Label>
          <Input id="businessName" value={form.businessName} onChange={set("businessName")} placeholder="e.g. Green Haven Enterprises" className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="nurseryName">Nursery Name *</Label>
          <Input id="nurseryName" value={form.nurseryName} onChange={set("nurseryName")} placeholder="e.g. Green Haven Nursery" className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="ownerName">Owner Name *</Label>
          <Input id="ownerName" value={form.ownerName} onChange={set("ownerName")} className="mt-1.5" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="contactPhone">Phone *</Label>
            <Input id="contactPhone" value={form.contactPhone} onChange={set("contactPhone")} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="contactEmail">Email *</Label>
            <Input id="contactEmail" type="email" value={form.contactEmail} onChange={set("contactEmail")} className="mt-1.5" />
          </div>
        </div>
        <div>
          <Label htmlFor="location">Location *</Label>
          <Input id="location" value={form.location} onChange={set("location")} placeholder="e.g. Savar, Dhaka" className="mt-1.5" />
        </div>
        <div>
          <Label htmlFor="description">Tell us about your nursery</Label>
          <Textarea id="description" value={form.description} onChange={set("description")} rows={4} className="mt-1.5" />
        </div>
        <Button type="submit" className="w-full rounded-full" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit Application"}
        </Button>
      </form>
    </div>
  );
}

export function BecomeSellerPage() {
  return (
    <div className="container mx-auto px-4 py-10 max-w-lg">
      <PageBreadcrumb crumbs={[{ label: "Become a Seller", icon: <Sprout className="h-3 w-3" /> }]} className="mb-4" />
      <BecomeSellerContent />
    </div>
  );
}
