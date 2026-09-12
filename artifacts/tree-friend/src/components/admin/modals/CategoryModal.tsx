import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useCreateCategory, useUpdateCategory, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X, Loader2, UploadIcon } from "lucide-react";
import { toast } from "sonner";

/**
 * Add/Edit form for a single category OR subcategory.
 *
 * The parent is never chosen from a dropdown here -- it is fixed by which
 * page the admin opened this modal from:
 *   - Opened from the top-level Categories page  -> parentId = null
 *   - Opened from inside a category's subcategory page -> parentId = that category's id
 *
 * `fixedParentId` is passed in by the parent page and is not editable here.
 */

// Match the backend multer fileSize limit (artifacts/api-server/src/routes/assets.ts:11).
// Validated client-side so we don't waste a round-trip on an obviously-too-big file.
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

export function CategoryModal({
  category,
  fixedParentId,
  onClose,
}: {
  category?: any;
  fixedParentId: number | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { getToken } = useAuth();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();

  const [form, setForm] = useState({
    name: category?.name ?? "",
    slug: category?.slug ?? "",
    description: category?.description ?? "",
    icon: category?.icon ?? "",
    iconImage: category?.iconImage ?? "",
    image: category?.image ?? "",
    displayOrder: category?.displayOrder ?? 0,
  });

  // Track which upload is in-flight so we can show a spinner + disable the
  // button. Keys match the form field the upload populates.
  const [uploading, setUploading] = useState<null | "iconImage" | "image">(null);

  // Refs to the hidden <input type="file"> elements. We need to reset their
  // `value` to "" after every upload attempt (success OR failure) so the
  // user can re-select the same file. Without this, if the user uploads
  // icon.png, clicks X to delete it, then tries to upload icon.png again,
  // the onChange event won't fire because the input's value didn't change.
  // This is a well-known React gotcha with file inputs.
  const iconInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const isSubcategory = fixedParentId !== null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data = {
      name: form.name,
      slug: form.slug || form.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
      description: form.description || null,
      icon: form.icon || null,
      iconImage: form.iconImage || null,
      image: form.image || null,
      displayOrder: Number(form.displayOrder),
      parentId: fixedParentId,
    };
    if (category) {
      updateCategory.mutate({ id: category.id, data }, {
        onSuccess: () => { qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() }); onClose(); },
      });
    } else {
      createCategory.mutate({ data }, {
        onSuccess: () => { qc.invalidateQueries({ queryKey: getListCategoriesQueryKey() }); onClose(); },
      });
    }
  }

  /**
   * Shared upload handler for icon + category images. Fixes several bugs:
   *
   * 1. **File size validation**: checked client-side before the fetch, so
   *    the user gets instant feedback instead of a 413 from multer.
   * 2. **HTTP error handling**: checks `res.ok` and surfaces the actual
   *    error message from the JSON body (or the HTTP status text as
   *    fallback). The old code silently did nothing on non-OK responses.
   * 3. **Loading state**: `uploading` is set before the fetch and cleared
   *    in `finally`, so the button shows a spinner + is disabled during
   *    upload — prevents double-clicks from firing duplicate requests.
   * 4. **File input reset**: the input's `value` is reset to "" after
   *    every attempt, so the user can re-select the same file.
   * 5. **Toast feedback**: success/error toasts via sonner, replacing the
   *    old bare `alert("Upload failed")` which gave zero diagnostic info.
   */
  async function uploadAsset(
    file: File,
    field: "iconImage" | "image",
    inputRef: React.RefObject<HTMLInputElement | null>,
  ) {
    if (file.size > MAX_UPLOAD_SIZE) {
      toast.error(`File is too large`, {
        description: `Maximum size is 5 MB. "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setUploading(field);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const token = await getToken();
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/assets/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });

      // Parse the response body regardless of status — the backend always
      // returns JSON (either { url } on success or { error } on failure).
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data?.error || data?.message || `Upload failed (HTTP ${res.status})`;
        toast.error("Upload failed", { description: msg });
        return;
      }

      if (data.url) {
        setForm(f => ({ ...f, [field]: data.url }));
        toast.success("Image uploaded", { description: field === "iconImage" ? "Icon updated." : "Category image updated." });
      } else {
        toast.error("Upload failed", { description: "Server did not return a URL." });
      }
    } catch {
      toast.error("Upload failed", { description: "Network error — please check your connection and try again." });
    } finally {
      setUploading(null);
      // Critical: reset the input value so the same file can be selected
      // again. Without this, the user can never re-upload the same file
      // after deleting it (onChange won't fire if the value didn't change).
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-lg">
            {category
              ? isSubcategory ? "Edit Subcategory" : "Edit Category"
              : isSubcategory ? "Add Subcategory" : "Add Category"}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {isSubcategory ? "Subcategory Name *" : "Category Name *"}
            </Label>
            <Input
              value={form.name}
              onChange={e => {
                const name = e.target.value;
                setForm(f => ({
                  ...f,
                  name,
                  slug: f.slug || name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
                }));
              }}
              required
              className="mt-1.5 rounded-xl"
              placeholder={isSubcategory ? "e.g. Mango" : "e.g. Fruit Trees"}
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Slug (auto-generated)</Label>
            <Input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              className="mt-1.5 rounded-xl font-mono text-sm"
              placeholder={isSubcategory ? "mango" : "fruit-trees"}
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description (optional)</Label>
            <Textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="mt-1.5 rounded-xl"
              placeholder={isSubcategory
                ? "Shown on the Mango listing page, e.g. a short intro to mango varieties."
                : "Shown on the Fruit Trees landing page."}
              rows={3}
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Icon (emoji, optional)</Label>
            <Input
              value={form.icon}
              onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}
              className="mt-1.5 rounded-xl"
              placeholder="🌳"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">Type an emoji, or upload an icon image below instead. If both are set, the uploaded image takes priority.</p>
            <div className="mt-2 flex gap-2 items-center">
              <Input
                value={form.iconImage}
                onChange={e => setForm(f => ({ ...f, iconImage: e.target.value }))}
                className="rounded-xl flex-1"
                placeholder="Paste icon image URL or upload"
                disabled={uploading === "iconImage"}
              />
              <label className={(
                "cursor-pointer shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm hover:bg-muted transition-colors " +
                (uploading === "iconImage" ? "pointer-events-none opacity-60" : "")
              )}>
                {uploading === "iconImage" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Uploading
                  </>
                ) : (
                  <>
                    <UploadIcon className="h-3.5 w-3.5" />
                    Upload
                  </>
                )}
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading === "iconImage"}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAsset(file, "iconImage", iconInputRef);
                  }}
                />
              </label>
            </div>
            {form.iconImage && (
              <div className="relative mt-2 inline-block">
                <img src={form.iconImage} alt="icon preview" className="h-14 w-14 object-cover rounded-full border border-border" />
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, iconImage: "" }))}
                  className="absolute -top-1.5 -right-1.5 bg-foreground/60 hover:bg-foreground/80 text-background rounded-full p-1 transition-colors"
                  title="Remove icon image"
                  disabled={uploading === "iconImage"}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {isSubcategory ? "Subcategory Image (optional)" : "Category Image (optional)"}
            </Label>
            <div className="mt-1.5 flex gap-2 items-center">
              <Input
                value={form.image}
                onChange={e => setForm(f => ({ ...f, image: e.target.value }))}
                className="rounded-xl flex-1"
                placeholder="Paste image URL or upload"
                disabled={uploading === "image"}
              />
              <label className={(
                "cursor-pointer shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border text-sm hover:bg-muted transition-colors " +
                (uploading === "image" ? "pointer-events-none opacity-60" : "")
              )}>
                {uploading === "image" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Uploading
                  </>
                ) : (
                  <>
                    <UploadIcon className="h-3.5 w-3.5" />
                    Upload
                  </>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading === "image"}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadAsset(file, "image", imageInputRef);
                  }}
                />
              </label>
            </div>
            {form.image && (
              <div className="relative mt-2">
                <img src={form.image} alt="preview" className="h-24 w-full object-cover rounded-xl" />
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, image: "" }))}
                  className="absolute top-1.5 right-1.5 bg-foreground/60 hover:bg-foreground/80 text-background rounded-full p-1 transition-colors"
                  title="Remove image"
                  disabled={uploading === "image"}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Display Order</Label>
            <Input
              type="number"
              value={form.displayOrder}
              onChange={e => setForm(f => ({ ...f, displayOrder: parseInt(e.target.value) || 0 }))}
              className="mt-1.5 rounded-xl"
              placeholder="0"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="submit" disabled={createCategory.isPending || updateCategory.isPending || uploading !== null} className="flex-1 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground">
              {category ? "Update" : "Add"} {isSubcategory ? "Subcategory" : "Category"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
