import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import {
  Store, Loader2, Upload, X, FileText, PalmtreeIcon, ShieldCheck,
  ShieldAlert, XCircle, BadgeCheck, Clock, Image as ImageIcon, Save,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  useGetMySeller,
  useUpdateMySellerProfile,
  useUpdateMySellerStatus,
  useRequestSellerVerification,
  getGetMySellerQueryKey,
  type Seller,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

function draftFromSeller(s: Seller) {
  return {
    businessName: s.businessName,
    nurseryName: s.nurseryName,
    ownerName: s.ownerName,
    contactPhone: s.contactPhone,
    contactEmail: s.contactEmail,
    location: s.location,
    description: s.description ?? "",
    nurseryImages: s.nurseryImages,
    nidOrTradeLicenseUrl: s.nidOrTradeLicenseUrl,
    logoUrl: s.logoUrl ?? null,
  };
}

type Draft = ReturnType<typeof draftFromSeller>;

function FieldRow({
  label, children, hint, required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label className="text-xs font-medium text-foreground">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <div className="mt-1.5">{children}</div>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function SectionCard({
  icon: Icon, iconClass, title, subtitle, children, footer,
}: {
  icon: React.ElementType;
  iconClass: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center gap-3">
          <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center shrink-0", iconClass)}>
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
          </div>
        </div>
      </header>
      <div className="p-5">{children}</div>
      {footer && <div className="px-5 py-4 border-t border-border/60 bg-muted/30">{footer}</div>}
    </section>
  );
}

export function BusinessProfileForm() {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const { data: seller, isLoading } = useGetMySeller();
  const updateProfile = useUpdateMySellerProfile();
  const updateStatus = useUpdateMySellerStatus();
  const requestVerification = useRequestSellerVerification();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  useEffect(() => {
    if (seller) setDraft(draftFromSeller(seller));
  }, [seller?.id]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: getGetMySellerQueryKey() });
  }

  async function uploadFile(file: File): Promise<string> {
    const token = await getToken();
    const fd = new FormData();
    fd.append("file", file);
    const base = import.meta.env.VITE_API_BASE_URL ?? "";
    const res = await fetch(`${base}/api/sellers/upload-verification-doc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) throw new Error("Upload failed");
    const data = await res.json();
    return data.url as string;
  }

  async function handleDocUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingDoc(true);
    try {
      const url = await uploadFile(files[0]);
      set("nidOrTradeLicenseUrl", url);
      toast.success("Document uploaded");
    } catch {
      toast.error("Document upload failed");
    } finally {
      setUploadingDoc(false);
    }
  }

  async function handleImagesUpload(files: FileList | null) {
    if (!files || files.length === 0 || !draft) return;
    setUploadingImages(true);
    try {
      const urls = await Promise.all(Array.from(files).map(uploadFile));
      set("nurseryImages", [...draft.nurseryImages, ...urls]);
      toast.success(`${urls.length} image${urls.length === 1 ? "" : "s"} uploaded`);
    } catch {
      toast.error("Image upload failed");
    } finally {
      setUploadingImages(false);
    }
  }

  async function handleLogoUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingLogo(true);
    try {
      const url = await uploadFile(files[0]);
      set("logoUrl", url);
      toast.success("Logo uploaded");
    } catch {
      toast.error("Logo upload failed");
    } finally {
      setUploadingLogo(false);
    }
  }

  function removeImage(url: string) {
    if (!draft) return;
    set("nurseryImages", draft.nurseryImages.filter((i) => i !== url));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    if (!draft.businessName.trim() || !draft.nurseryName.trim() || !draft.ownerName.trim() ||
        !draft.contactPhone.trim() || !draft.contactEmail.trim() || !draft.location.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    updateProfile.mutate(
      {
        data: {
          businessName: draft.businessName.trim(),
          nurseryName: draft.nurseryName.trim(),
          ownerName: draft.ownerName.trim(),
          contactPhone: draft.contactPhone.trim(),
          contactEmail: draft.contactEmail.trim(),
          location: draft.location.trim(),
          description: draft.description.trim() || null,
          nurseryImages: draft.nurseryImages,
          nidOrTradeLicenseUrl: draft.nidOrTradeLicenseUrl,
          logoUrl: draft.logoUrl,
        },
      },
      {
        onSuccess: () => { toast.success("Profile updated"); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update profile"),
      },
    );
  }

  function toggleVacation(checked: boolean) {
    const nextStatus = checked ? "vacation" : "active";
    updateStatus.mutate(
      { data: { status: nextStatus } },
      {
        onSuccess: () => {
          toast.success(nextStatus === "vacation" ? "You're now on vacation — your listings are hidden from buyers" : "Welcome back — your listings are visible again");
          invalidate();
        },
        onError: (err: any) => toast.error(err?.message ?? "Failed to update status"),
      },
    );
  }

  function handleRequestVerification() {
    requestVerification.mutate(undefined, {
      onSuccess: () => {
        toast.success("Verification requested — an admin will review it soon");
        invalidate();
      },
      onError: (err: any) => toast.error(err?.message ?? "Failed to request verification"),
    });
  }

  if (isLoading || !draft || !seller) {
    return (
      <div className="space-y-4">
        <div className="h-32 rounded-2xl bg-muted animate-pulse" />
        <div className="h-32 rounded-2xl bg-muted animate-pulse" />
        <div className="h-96 rounded-2xl bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-5 max-w-4xl">
      {/* Vacation mode */}
      <SectionCard
        icon={PalmtreeIcon}
        iconClass="bg-amber-50 text-amber-700"
        title="Vacation Mode"
        subtitle="Temporarily hide your listings from buyers."
      >
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {seller.status === "vacation"
              ? "Your listings are hidden from buyers right now. Toggle off to resume selling."
              : "When on, your listings disappear from search and your store, and Orders/Listings tabs are locked."}
          </p>
          <Switch
            checked={seller.status === "vacation"}
            onCheckedChange={toggleVacation}
            disabled={updateStatus.isPending || (seller.status !== "active" && seller.status !== "vacation")}
          />
        </div>
        {seller.status !== "active" && seller.status !== "vacation" && (
          <p className="text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Vacation mode is only available for active seller accounts.
          </p>
        )}
      </SectionCard>

      {/* Verification */}
      <SectionCard
        icon={BadgeCheck}
        iconClass="bg-emerald-50 text-emerald-700"
        title="Verified Seller Badge"
        subtitle="Earn a verified checkmark buyers see on your listings."
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm text-foreground">
              {seller.isVerified
                ? "Your listings show a verified checkmark to buyers."
                : "Verification builds buyer trust and improves listing visibility."}
            </p>
          </div>
          {seller.isVerified ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-full px-3 py-1.5 ring-1 ring-emerald-200/60 shrink-0">
              <CheckCircle2 className="h-4 w-4" />
              Verified
            </span>
          ) : seller.verificationRequestStatus === "requested" ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 bg-amber-50 rounded-full px-3 py-1.5 ring-1 ring-amber-200/60 shrink-0">
              <Clock className="h-4 w-4" />
              Pending review
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl shrink-0"
              disabled={requestVerification.isPending || seller.status !== "active"}
              onClick={handleRequestVerification}
            >
              {requestVerification.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Request Verification
            </Button>
          )}
        </div>

        {seller.status !== "active" && !seller.isVerified && (
          <p className="text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Verification can only be requested from an active seller account.
          </p>
        )}

        {seller.verificationRequestStatus === "rejected" && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Your last request wasn't approved{seller.verificationRejectionReason ? `: ${seller.verificationRejectionReason}` : "."} You can request again once you've addressed this.
          </p>
        )}
      </SectionCard>

      {/* Business profile */}
      <SectionCard
        icon={Store}
        iconClass="bg-violet-50 text-violet-700"
        title="Business Profile"
        subtitle="Your public business and nursery details shown to buyers."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FieldRow label="Business Name" required>
              <Input value={draft.businessName} onChange={(e) => set("businessName", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Nursery Name" required>
              <Input value={draft.nurseryName} onChange={(e) => set("nurseryName", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Owner Name" required>
              <Input value={draft.ownerName} onChange={(e) => set("ownerName", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Location" required>
              <Input value={draft.location} onChange={(e) => set("location", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Contact Phone" required>
              <Input value={draft.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
            <FieldRow label="Contact Email" required>
              <Input type="email" value={draft.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className="h-10 rounded-xl" />
            </FieldRow>
          </div>

          <FieldRow label="Description" hint="Optional. Tell buyers about your nursery and what makes it special.">
            <Textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="e.g. Family-run nursery specializing in rare ficus varieties since 2018…"
              className="rounded-xl text-sm"
              rows={3}
            />
          </FieldRow>
        </div>
      </SectionCard>

      {/* Logo */}
      <SectionCard
        icon={ImageIcon}
        iconClass="bg-sky-50 text-sky-700"
        title="Store Logo"
        subtitle="Shown as your square avatar on buyer-facing listing pages."
      >
        <div className="flex items-center gap-4">
          {draft.logoUrl ? (
            <div className="relative">
              <img src={draft.logoUrl} alt="" className="h-20 w-20 rounded-xl object-cover border border-border" />
              <button
                type="button"
                onClick={() => set("logoUrl", null)}
                className="absolute -top-1.5 -right-1.5 bg-foreground/80 hover:bg-foreground text-background rounded-full p-1 transition-colors"
                title="Remove logo"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <label className="h-20 w-20 rounded-xl border-2 border-dashed border-border flex items-center justify-center cursor-pointer text-muted-foreground hover:bg-muted/40 hover:border-foreground/30 transition-colors">
              {uploadingLogo ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
              <input type="file" accept="image/*" className="hidden" disabled={uploadingLogo} onChange={(e) => handleLogoUpload(e.target.files)} />
            </label>
          )}
          <div className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground mb-0.5">Square image recommended</p>
            <p>Min 200×200px · PNG, JPG, or WebP</p>
          </div>
        </div>
      </SectionCard>

      {/* Nursery photos */}
      <SectionCard
        icon={ImageIcon}
        iconClass="bg-emerald-50 text-emerald-700"
        title="Nursery Photos"
        subtitle="Show buyers what your nursery looks like — builds trust."
      >
        <div className="flex flex-wrap gap-3">
          {draft.nurseryImages.map((url) => (
            <div key={url} className="relative">
              <img src={url} alt="" className="h-20 w-20 rounded-xl object-cover border border-border" />
              <button
                type="button"
                onClick={() => removeImage(url)}
                className="absolute -top-1.5 -right-1.5 bg-foreground/80 hover:bg-foreground text-background rounded-full p-1 transition-colors"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <label className="h-20 w-20 rounded-xl border-2 border-dashed border-border flex items-center justify-center cursor-pointer text-muted-foreground hover:bg-muted/40 hover:border-foreground/30 transition-colors">
            {uploadingImages ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploadingImages} onChange={(e) => handleImagesUpload(e.target.files)} />
          </label>
        </div>
      </SectionCard>

      {/* Verification doc */}
      <SectionCard
        icon={FileText}
        iconClass="bg-amber-50 text-amber-700"
        title="Trade License / NID"
        subtitle="Optional document to speed up admin verification."
      >
        <div>
          {draft.nidOrTradeLicenseUrl ? (
            <div className="flex items-center justify-between bg-muted/40 rounded-xl border border-border px-4 py-3">
              <a
                href={draft.nidOrTradeLicenseUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 text-sm text-accent-text hover:underline min-w-0"
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">View uploaded document</span>
              </a>
              <button
                type="button"
                onClick={() => set("nidOrTradeLicenseUrl", null)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-rose-50 transition-colors shrink-0"
                title="Remove document"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 h-10 rounded-xl border-2 border-dashed border-border px-4 text-sm text-muted-foreground hover:bg-muted/40 hover:border-foreground/30 transition-colors cursor-pointer w-fit">
              {uploadingDoc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload document
              <input type="file" accept="image/*,.pdf" className="hidden" disabled={uploadingDoc} onChange={(e) => handleDocUpload(e.target.files)} />
            </label>
          )}

          {seller.status === "pending_verification" && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Your application is pending admin review — uploading a trade license or NID helps verification go faster.
            </p>
          )}
          {seller.status === "active" && draft.nidOrTradeLicenseUrl && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Document on file.
            </p>
          )}
        </div>
      </SectionCard>

      {/* Save bar */}
      <div className="sticky bottom-4 z-10">
        <div className="rounded-2xl border border-border bg-card shadow-lg px-5 py-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground hidden sm:block">
            Don't forget to save your changes before navigating away.
          </p>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              type="submit"
              disabled={updateProfile.isPending}
              className="rounded-xl"
            >
              {updateProfile.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1.5" />
              )}
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
