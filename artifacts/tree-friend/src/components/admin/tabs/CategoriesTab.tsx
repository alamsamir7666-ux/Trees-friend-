import { useState } from "react";
import { useAdminContext } from "@/contexts/AdminContext";
import { Button } from "@/components/ui/button";
import { Layers, Plus, Pencil, Trash2, ChevronRight, ChevronLeft, ListTree } from "lucide-react";
import { CategoryModal } from "@/components/admin/modals/CategoryModal";
import { CategoryAttributeOptionsModal } from "@/components/admin/modals/CategoryAttributeOptionsModal";

/**
 * 3-level drill-down category manager:
 *   Page 1: top-level categories (parentId = null)      e.g. Fruit Trees
 *   Page 2: subcategories of the selected category       e.g. Mango, Guava
 *   Page 3: products/varieties inside the selected sub    e.g. Alphonso Mango
 *
 * Navigation is local component state (selectedCategoryId / selectedSubcategoryId),
 * not a URL route -- this app does not use a router elsewhere, so this stays
 * consistent with the rest of the admin panel.
 *
 * The "parent" for Add/Edit is never chosen in the form -- it is implied by
 * which page you are on, and passed into CategoryModal as `fixedParentId`.
 */
export function CategoriesTab() {
  const {
    categories,
    editingCategory,
    setEditingCategory,
    showCategoryModal,
    setShowCategoryModal,
    seedingCategories,
    setSeedingCategories,
    products,
    handleDeleteCategory,
    handleSeedCategories,
  } = useAdminContext();

  const allCats = categories as any[];
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<number | null>(null);
  const [modalParentId, setModalParentId] = useState<number | null>(null);
  const [optionsModalCategory, setOptionsModalCategory] = useState<{ id: number; name: string } | null>(null);

  const selectedCategory = allCats.find(c => c.id === selectedCategoryId) ?? null;
  const selectedSubcategory = allCats.find(c => c.id === selectedSubcategoryId) ?? null;

  function openAdd(fixedParentId: number | null) {
    setEditingCategory(null);
    setModalParentId(fixedParentId);
    setShowCategoryModal(true);
  }

  function openEdit(cat: any) {
    setEditingCategory(cat);
    setModalParentId(cat.parentId ?? null);
    setShowCategoryModal(true);
  }

  if (selectedCategory && selectedSubcategory) {
    const varietyProducts = products.filter((p: any) => p.categoryId === selectedSubcategory.id);
    return (
      <div>
        <Breadcrumbs
          items={[
            { label: "Categories", onClick: () => { setSelectedCategoryId(null); setSelectedSubcategoryId(null); } },
            { label: selectedCategory.name, onClick: () => setSelectedSubcategoryId(null) },
            { label: selectedSubcategory.name },
          ]}
        />
        <div className="flex items-center justify-between mb-4 mt-3">
          <p className="text-sm text-gray-500">
            Varieties are just products. Manage full details (price, stock, images, care info) from the Products tab -- this view is a quick filtered look at what is inside "{selectedSubcategory.name}".
          </p>
        </div>
        {varietyProducts.length === 0 ? (
          <div className="bg-white rounded-2xl border p-12 text-center">
            <Layers className="h-12 w-12 text-gray-200 mx-auto mb-4" />
            <p className="font-semibold text-gray-500 mb-1">No varieties yet in "{selectedSubcategory.name}"</p>
            <p className="text-sm text-gray-400">Add products from the Products tab and set their category to "{selectedSubcategory.name}".</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Variety</th>
                    <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {varietyProducts.map((p: any) => (
                    <tr key={p.id} className="hover:bg-pink-50/30 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-gray-800">{p.name}</p>
                      </td>
                      {/* Phase 5: was a raw dump of p.productStatus (the
                          removed admin-set field -- see ProductModal.tsx).
                          Same listingCount/listingHasPreOrder signal as
                          ProductsTab.tsx's Stock/Status column. */}
                      <td className="px-5 py-3 text-right text-gray-500 text-xs">
                        {((p as any).listingHasPreOrder ?? false)
                          ? "Pre-Order"
                          : ((p as any).listingCount ?? 0) > 0
                            ? "In Stock"
                            : "Out of Stock"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (selectedCategory) {
    const subs = allCats.filter(c => c.parentId === selectedCategory.id);
    return (
      <div>
        <Breadcrumbs
          items={[
            { label: "Categories", onClick: () => setSelectedCategoryId(null) },
            { label: selectedCategory.name },
          ]}
        />
        <div className="flex items-center justify-between mb-4 mt-3">
          <p className="text-sm text-gray-500">Subcategories inside "{selectedCategory.name}". Click one to see its varieties.</p>
          <Button onClick={() => openAdd(selectedCategory.id)} className="rounded-xl bg-pink-500 hover:bg-pink-600 text-white shrink-0">
            <Plus className="h-4 w-4 mr-1.5" /> Add Subcategory
          </Button>
        </div>

        {subs.length === 0 ? (
          <div className="bg-white rounded-2xl border p-12 text-center">
            <Layers className="h-12 w-12 text-gray-200 mx-auto mb-4" />
            <p className="font-semibold text-gray-500 mb-1">No subcategories yet</p>
            <p className="text-sm text-gray-400 mb-4">Add a subcategory (e.g. "Mango") inside "{selectedCategory.name}".</p>
            <Button onClick={() => openAdd(selectedCategory.id)} className="rounded-xl bg-pink-500 hover:bg-pink-600 text-white">
              <Plus className="h-4 w-4 mr-1.5" /> Add First Subcategory
            </Button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Subcategory</th>
                    <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Slug</th>
                    <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Varieties</th>
                    <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {subs.map((sub: any) => {
                    const productCount = products.filter((p: any) => p.categoryId === sub.id).length;
                    return (
                      <tr key={sub.id} className="hover:bg-pink-50/30 transition-colors cursor-pointer" onClick={() => setSelectedSubcategoryId(sub.id)}>
                        <td className="px-5 py-3">
                          <p className="font-medium text-gray-800">{sub.icon} {sub.name}</p>
                        </td>
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">{sub.slug}</span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <span className="text-sm font-semibold text-gray-700">{productCount}</span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                            <button onClick={() => setOptionsModalCategory({ id: sub.id, name: sub.name })}
                              title="Manage listing attribute options (height, pot size, age, root type)"
                              className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 transition-colors">
                              <ListTree className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => openEdit(sub)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => handleDeleteCategory(sub.id)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setSelectedSubcategoryId(sub.id)}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-pink-500 hover:bg-pink-50 transition-colors">
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showCategoryModal && (
          <CategoryModal
            category={editingCategory}
            fixedParentId={modalParentId}
            onClose={() => setShowCategoryModal(false)}
          />
        )}

        {optionsModalCategory && (
          <CategoryAttributeOptionsModal
            categoryId={optionsModalCategory.id}
            categoryName={optionsModalCategory.name}
            onClose={() => setOptionsModalCategory(null)}
          />
        )}
      </div>
    );
  }

  const topLevel = allCats.filter(c => !c.parentId);
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Manage your top-level categories. Click one to manage its subcategories.</p>
        <div className="flex gap-2">
          {topLevel.length === 0 && (
            <Button
              variant="outline"
              onClick={handleSeedCategories}
              disabled={seedingCategories}
              className="rounded-xl text-sm shrink-0"
            >
              {seedingCategories ? "Loading..." : "Load Defaults"}
            </Button>
          )}
          <Button onClick={() => openAdd(null)} className="rounded-xl bg-pink-500 hover:bg-pink-600 text-white shrink-0">
            <Plus className="h-4 w-4 mr-1.5" /> Add Category
          </Button>
        </div>
      </div>

      {topLevel.length === 0 ? (
        <div className="bg-white rounded-2xl border p-12 text-center">
          <Layers className="h-12 w-12 text-gray-200 mx-auto mb-4" />
          <p className="font-semibold text-gray-500 mb-1">No categories yet</p>
          <p className="text-sm text-gray-400 mb-4">Add your first category to organize products and update the navigation menu.</p>
          <Button onClick={() => openAdd(null)} className="rounded-xl bg-pink-500 hover:bg-pink-600 text-white">
            <Plus className="h-4 w-4 mr-1.5" /> Add First Category
          </Button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Category</th>
                  <th className="px-5 py-3.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Slug</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Subcategories</th>
                  <th className="px-5 py-3.5 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {topLevel.map((cat: any) => {
                  const subCount = allCats.filter((c: any) => c.parentId === cat.id).length;
                  return (
                    <tr key={cat.id} className="hover:bg-pink-50/30 transition-colors cursor-pointer" onClick={() => setSelectedCategoryId(cat.id)}>
                      <td className="px-5 py-3">
                        <p className="font-bold text-gray-800">{cat.icon} {cat.name}</p>
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-mono text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">{cat.slug}</span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className="text-sm font-semibold text-gray-700">{subCount}</span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                          <button onClick={() => openEdit(cat)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => handleDeleteCategory(cat.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setSelectedCategoryId(cat.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-pink-500 hover:bg-pink-50 transition-colors">
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCategoryModal && (
        <CategoryModal
          category={editingCategory}
          fixedParentId={modalParentId}
          onClose={() => setShowCategoryModal(false)}
        />
      )}
    </div>
  );
}

function Breadcrumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-gray-500 mb-1">
      <button
        onClick={items[0]?.onClick}
        className="flex items-center gap-1 hover:text-pink-600 transition-colors -ml-1 px-1 py-0.5 rounded"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back
      </button>
      <span className="mx-1 text-gray-300">|</span>
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-gray-300" />}
          {item.onClick ? (
            <button onClick={item.onClick} className="hover:text-pink-600 transition-colors font-medium">
              {item.label}
            </button>
          ) : (
            <span className="font-semibold text-gray-800">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
