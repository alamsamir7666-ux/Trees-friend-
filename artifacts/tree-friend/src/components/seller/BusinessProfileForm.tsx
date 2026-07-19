import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Store, Loader2, Upload, X, FileText, PalmtreeIcon, ShieldCheck, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  useGetMySeller,
  useUpdateMySellerProfile,
  useUpdateMySellerStatus,
  getGetMySellerQueryKey,
  type Seller,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Business Profile (plan §4 item 1, merged with item 2 "Store Settings" --
 * every sellers-table field not already covered by Payment/Courier
 * Settings lives here, and nothing was left over after this form was
 * built, so no separate Store Settings section was added; see handoff).
 * Also hosts Vacation Mode (item 3) since it's a status field on the same
 * table with no other natural home, and Business Verification's
 * seller-facing doc upload (item 5), which was previously entirely
 * unwired despite the upload endpoint working.
 *
 * Mirrors PaymentSettingsForm.tsx / CourierSettingsForm.tsx's card shape
 * and toast-on-success/error pattern, and SellerListingForm.tsx's
 * image-upload gallery UI for nurseryImages / the verification doc.
 */
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
  };
}

type Draft = ReturnType<typeof draftFromSeller>;

export function BusinessProfileForm() {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const { data: seller, isLoading } = useGetMySeller();
  const updateProfile = useUpdateMySellerProfile();
  const updateStatus = useUpdateMySellerStatus();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);

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
    } catch {
      toast.error("Image upload failed");
    } finally {
      setUploadingImages(false);
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

  if (isLoading || !draft || !seller) {
    return (
      <div className="space-y-3">
        <div className="h-40 rounded-2xl bg-muted animate-pulse" />
        <div className="h-24 rounded-2xl bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Vacation mode -- kept as its own card, above the edit form, since
          it's a status toggle rather than a profile field and takes effect
          immediately (no Save button). */}
      <div className="bg-card rounded-2xl border p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
              <PalmtreeIcon className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="font-medium text-sm">Vacation Mode</p>
              <p className="text-xs text-muted-foreground">
                {seller.status === "vacation"
                  ? "Your listings are hidden from buyers right now."
                  : "Temporarily hide your listings from buyers."}
              </p>
            </div>
          </div>
          <Switch
            checked={seller.status === "vacation"}
            onCheckedChange={toggleVacation}
            disabled={updateStatus.isPending || (seller.status !== "active" && seller.status !== "vacation")}
          />
        </div>
        {seller.status !== "active" && seller.status !== "vacation" && (
          <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2 mt-3 flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            Vacation mode is only available for active seller accounts.
          </p>
        )}
      </div>

      <form onSubmit={handleSave} className="bg-card rounded-2xl border p-5 space-y-3">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
            <Store className="h-5 w-5 text-accent" />
          </div>
          <div>
            <p className="font-medium text-sm">Business Profile</p>
            <p className="text-xs text-muted-foreground">Your public business and nursery details.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Business Name *</Label>
            <Input value={draft.businessName} onChange={(e) => set("businessName", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Nursery Name *</Label>
            <Input value={draft.nurseryName} onChange={(e) => set("nurseryName", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Owner Name *</Label>
            <Input value={draft.ownerName} onChange={(e) => set("ownerName", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Location *</Label>
            <Input value={draft.location} onChange={(e) => set("location", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Contact Phone *</Label>
            <Input value={draft.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Contact Email *</Label>
            <Input type="email" value={draft.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className="mt-1 h-9 rounded-lg text-sm" />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Description</Label>
          <Textarea value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional" className="mt-1 rounded-lg text-sm" rows={3} />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Nursery Photos</Label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {draft.nurseryImages.map((url) => (
              <div key={url} className="relative">
                <img src={url} alt="" className="h-16 w-16 rounded-lg object-cover border" />
                <button type="button" onClick={() => removeImage(url)} className="absolute -top-1.5 -right-1.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <label className="h-16 w-16 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer text-muted-foreground hover:bg-muted/30 transition-colors">
              {uploadingImages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              <input type="file" accept="image/*" multiple className="hidden" disabled={uploadingImages} onChange={(e) => handleImagesUpload(e.target.files)} />
            </label>
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Trade License / NID</Label>
          <div className="mt-1.5">
            {draft.nidOrTradeLicenseUrl ? (
              <div className="flex items-center justify-between bg-muted/30 rounded-lg border px-3 py-2">
                <a href={draft.nidOrTradeLicenseUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-accent hover:underline min-w-0">
                  <FileText className="h-4 w-4 shrink-0" />
                  <span className="truncate">View uploaded document</span>
                </a>
                <button type="button" onClick={() => set("nidOrTradeLicenseUrl", null)} className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors shrink-0">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <label className="flex items-center gap-2 h-9 rounded-lg border-2 border-dashed px-3 text-sm text-muted-foreground hover:bg-muted/30 transition-colors cursor-pointer w-fit">
                {uploadingDoc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload document
                <input type="file" accept="image/*,.pdf" className="hidden" disabled={uploadingDoc} onChange={(e) => handleDocUpload(e.target.files)} />
              </label>
            )}
          </div>
          {seller.status === "pending_verification" && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2 flex items-start gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Your application is pending admin review — uploading a trade license or NID helps verification go faster.
            </p>
          )}
          {seller.status === "active" && draft.nidOrTradeLicenseUrl && (
            <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 mt-2 flex items-start gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Document on file.
            </p>
          )}
        </div>

        <Button type="submit" disabled={updateProfile.isPending} className="w-full rounded-full gap-1.5 mt-2">
          {updateProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Changes"}
        </Button>
      </form>
    </div>
  );
}
