import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useCreateCategory, useUpdateCategory, getListCategoriesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-lg">
            {category
              ? isSubcategory ? "Edit Subcategory" : "Edit Category"
              : isSubcategory ? "Add Subcategory" : "Add Category"}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">
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
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Slug (auto-generated)</Label>
            <Input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
              className="mt-1.5 rounded-xl font-mono text-sm"
              placeholder={isSubcategory ? "mango" : "fruit-trees"}
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Description (optional)</Label>
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
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Icon (emoji, optional)</Label>
            <Input
              value={form.icon}
              onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}
              className="mt-1.5 rounded-xl"
              placeholder="🌳"
            />
            <p className="text-[11px] text-gray-400 mt-1">Type an emoji, or upload an icon image below instead. If both are set, the uploaded image takes priority.</p>
            <div className="mt-2 flex gap-2 items-center">
              <Input
                value={form.iconImage}
                onChange={e => setForm(f => ({ ...f, iconImage: e.target.value }))}
                className="rounded-xl flex-1"
                placeholder="Paste icon image URL or upload"
              />
              <label className="cursor-pointer shrink-0 px-3 py-2 rounded-xl border border-gray-200 text-sm hover:bg-gray-50 transition-colors">
                Upload
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const fd = new FormData();
                  fd.append("file", file);
                  try {
                    const token = await getToken();
                    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/assets/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
                    const data = await res.json();
                    if (data.url) setForm(f => ({ ...f, iconImage: data.url }));
                  } catch { alert("Upload failed"); }
                }} />
              </label>
            </div>
            {form.iconImage && (
              <div className="relative mt-2 inline-block">
                <img src={form.iconImage} alt="icon preview" className="h-14 w-14 object-cover rounded-full border border-gray-200" />
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, iconImage: "" }))}
                  className="absolute -top-1.5 -right-1.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-1 transition-colors"
                  title="Remove icon image"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">
              {isSubcategory ? "Subcategory Image (optional)" : "Category Image (optional)"}
            </Label>
            <div className="mt-1.5 flex gap-2 items-center">
              <Input
                value={form.image}
                onChange={e => setForm(f => ({ ...f, image: e.target.value }))}
                className="rounded-xl flex-1"
                placeholder="Paste image URL or upload"
              />
              <label className="cursor-pointer shrink-0 px-3 py-2 rounded-xl border border-gray-200 text-sm hover:bg-gray-50 transition-colors">
                Upload
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const fd = new FormData();
                  fd.append("file", file);
                  try {
                    const token = await getToken();
                    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api/assets/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
                    const data = await res.json();
                    if (data.url) setForm(f => ({ ...f, image: data.url }));
                  } catch { alert("Upload failed"); }
                }} />
              </label>
            </div>
            {form.image && (
              <div className="relative mt-2">
                <img src={form.image} alt="preview" className="h-24 w-full object-cover rounded-xl" />
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, image: "" }))}
                  className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-black/80 text-white rounded-full p-1 transition-colors"
                  title="Remove image"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
          <div>
            <Label className="text-xs font-medium text-gray-600 uppercase tracking-wider">Display Order</Label>
            <Input
              type="number"
              value={form.displayOrder}
              onChange={e => setForm(f => ({ ...f, displayOrder: parseInt(e.target.value) || 0 }))}
              className="mt-1.5 rounded-xl"
              placeholder="0"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="submit" disabled={createCategory.isPending || updateCategory.isPending} className="flex-1 rounded-xl bg-pink-500 hover:bg-pink-600 text-white">
              {category ? "Update" : "Add"} {isSubcategory ? "Subcategory" : "Category"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
