import { useState } from "react";
import { X, Plus, Trash2, Loader2, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useListListingAttributeOptions,
  useCreateListingAttributeOption,
  useDeleteListingAttributeOption,
  getListListingAttributeOptionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const ATTRIBUTES = [
  { key: "height", label: "Height" },
  { key: "pot_size", label: "Pot Size" },
  { key: "age", label: "Age" },
  { key: "root_type", label: "Root Type" },
] as const;

/**
 * Per plan doc §3a: "Admin is expected to seed a category's full option
 * sets as part of creating that category." This modal is where that
 * seeding actually happens -- one attribute at a time, free-text value +
 * append, since the plan doesn't specify a fixed universal option list
 * (heights/pot sizes vary a lot by plant category, e.g. a "Bonsai"
 * subcategory's height options look nothing like a "Fruit Sapling"
 * subcategory's). This intentionally does NOT try to guess a starter set
 * automatically -- an admin who understands the category should decide
 * what "small / medium / large" means for THIS category's varieties.
 */
export function CategoryAttributeOptionsModal({
  categoryId,
  categoryName,
  onClose,
}: {
  categoryId: number;
  categoryName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [activeAttribute, setActiveAttribute] = useState<(typeof ATTRIBUTES)[number]["key"]>("height");
  const [newValue, setNewValue] = useState("");

  const queryParams = { attributeName: activeAttribute };
  const { data: options, isLoading } = useListListingAttributeOptions(categoryId, queryParams);
  const createOption = useCreateListingAttributeOption();
  const deleteOption = useDeleteListingAttributeOption();

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListListingAttributeOptionsQueryKey(categoryId, queryParams) });
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const value = newValue.trim();
    if (!value) return;
    createOption.mutate(
      { data: { categoryId, attributeName: activeAttribute, value, displayOrder: options?.length ?? 0 } },
      {
        onSuccess: () => { setNewValue(""); invalidate(); },
        onError: (err: any) => toast.error(err?.message ?? "Failed to add option"),
      },
    );
  }

  function handleDelete(id: number) {
    deleteOption.mutate(
      { id },
      {
        onSuccess: invalidate,
        onError: (err: any) => toast.error(err?.message ?? "Failed to delete option"),
      },
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white z-10">
          <div>
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <ListTree className="h-4 w-4 text-pink-500" /> Listing Attribute Options
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Controlled dropdown values sellers pick from when listing a variety in "{categoryName}"
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-1.5 flex-wrap">
            {ATTRIBUTES.map((a) => (
              <button
                key={a.key}
                onClick={() => setActiveAttribute(a.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  activeAttribute === a.key ? "bg-pink-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleAdd} className="flex gap-2">
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={`Add a ${ATTRIBUTES.find((a) => a.key === activeAttribute)?.label.toLowerCase()} option, e.g. "3-4 ft"`}
              className="flex-1"
            />
            <Button type="submit" size="sm" className="rounded-xl bg-pink-500 hover:bg-pink-600 text-white shrink-0" disabled={createOption.isPending || !newValue.trim()}>
              {createOption.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </form>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <div key={i} className="h-9 rounded-lg bg-gray-100 animate-pulse" />)}
            </div>
          ) : !options || options.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No options yet for this attribute in this category.</p>
          ) : (
            <div className="space-y-1.5">
              {options.map((o) => (
                <div key={o.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 border">
                  <span className="text-sm text-gray-700">{o.value}</span>
                  <button
                    onClick={() => handleDelete(o.id)}
                    disabled={deleteOption.isPending}
                    className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
