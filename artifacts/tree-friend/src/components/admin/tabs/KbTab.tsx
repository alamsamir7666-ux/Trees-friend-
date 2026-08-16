import { useCallback, useEffect, useMemo, useState } from "react";
import { useApiFetch } from "@/lib/useApiFetch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  BookOpen,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  ArrowRightCircle,
  AlertCircle,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchKbCategoryTree,
  fetchKbCreators,
  fetchKbSources,
  fetchKbSource,
  fetchKbEntries,
  fetchKbInsights,
  testKbSearch,
  fetchToneProfileStatus,
  generateToneProfile,
  setToneMatchPercentage,
  updateKbCategory,
  moveKbCategory,
  deleteKbCategory,
  chunkSourceWithAI,
  activateKbEntry,
  deactivateKbEntry,
  deleteKbEntry,
  deleteKbSource,
  autoSlug,
  type KbCategory,
  type KbCategoryNode,
  type KbCreator,
  type KbSource,
  type KbSourceWithEntries,
  type KbEntry,
  type KbChunkResult,
  type KbInsights,
  type KbSearchTestResponse,
  type KbToneProfilesStatusResponse,
  type KbToneProfileStatus,
} from "@/lib/kbApi";
import { KbCategoryModal } from "@/components/admin/modals/KbCategoryModal";
import { KbSourceUploadModal } from "@/components/admin/modals/KbSourceUploadModal";
import { KbSourceEditModal } from "@/components/admin/modals/KbSourceEditModal";
import { KbChunkReviewModal } from "@/components/admin/modals/KbChunkReviewModal";
import { KbEntryEditorModal } from "@/components/admin/modals/KbEntryEditorModal";
import { KbToneProfileModal } from "@/components/admin/modals/KbToneProfileModal";

/**
 * Knowledge Base admin tab — Phase 2 wrapper.
 *
 * Renders sub-tab navigation (Categories / Sources / Entries) + delegates
 * to the appropriate view. The Categories view is the Phase 1 tree UI
 * (now `KbCategoriesView`). The Sources + Entries views are new in Phase 2.
 *
 * All three views share the same category tree (fetched once, passed down)
 * + the same apiFetch instance. Each view manages its own state.
 */
export function KbTab() {
  const apiFetch = useApiFetch();
  const [activeSubTab, setActiveSubTab] = useState<
    "categories" | "sources" | "entries" | "insights" | "tone"
  >("categories");
  // Shared category tree (used by Categories view + as dropdown options in
  // Sources/Entries modals). Fetched once on mount + refetched when any
  // view calls `refetchTree`.
  const [tree, setTree] = useState<KbCategoryNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [creators, setCreators] = useState<KbCreator[]>([]);

  const refetchTree = useCallback(async () => {
    try {
      const t = await fetchKbCategoryTree(apiFetch);
      setTree(t);
    } catch {
      // silent — the view will show an empty state
    } finally {
      setTreeLoading(false);
    }
  }, [apiFetch]);

  const refetchCreators = useCallback(async () => {
    try {
      const c = await fetchKbCreators(apiFetch);
      setCreators(c);
    } catch {
      // silent
    }
  }, [apiFetch]);

  useEffect(() => {
    refetchTree();
    refetchCreators();
  }, [refetchTree, refetchCreators]);

  return (
    <div className="space-y-4">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 border-b">
        {(["categories", "sources", "entries", "insights", "tone"] as const).map((id) => (
          <button
            key={id}
            onClick={() => setActiveSubTab(id)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeSubTab === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {id === "categories" && "Categories"}
            {id === "sources" && "Sources"}
            {id === "entries" && "Entries"}
            {id === "insights" && "Insights"}
            {id === "tone" && "Tone"}
          </button>
        ))}
      </div>

      {activeSubTab === "categories" && (
        <KbCategoriesView tree={tree} treeLoading={treeLoading} refetchTree={refetchTree} />
      )}
      {activeSubTab === "sources" && (
        <KbSourcesView tree={tree} creators={creators} refetchCreators={refetchCreators} />
      )}
      {activeSubTab === "entries" && <KbEntriesView tree={tree} />}
      {activeSubTab === "insights" && <KbInsightsView />}
      {activeSubTab === "tone" && <KbToneView />}
    </div>
  );
}

/**
 * Categories view — Phase 1's category tree UI.
 *
 * Extracted from the original `KbTab` so the new wrapper can add the
 * Sources + Entries sub-tabs. The category tree is now passed in as a
 * prop (fetched by the wrapper) so all three views share the same data.
 */
function KbCategoriesView({
  tree,
  treeLoading,
  refetchTree,
}: {
  tree: KbCategoryNode[];
  treeLoading: boolean;
  refetchTree: () => Promise<void>;
}) {
  const apiFetch = useApiFetch();
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  // Modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<KbCategory | null>(null);
  const [moveTarget, setMoveTarget] = useState<KbCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KbCategory | null>(null);
  const [moveParentId, setMoveParentId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ─── Data fetching ──────────────────────────────────────────────────────
  // The tree is fetched by the parent (KbTab) + passed as a prop. We
  // just wrap refetchTree with a refreshing flag for the spinner.
  const refetch = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        await refetchTree();
        // Auto-expand all root nodes so the tree is browsable.
        setExpanded((prev) => {
          const nextSet = new Set(prev);
          for (const root of tree) nextSet.add(root.id);
          return nextSet;
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load KB categories");
      } finally {
        setRefreshing(false);
      }
    },
    [refetchTree, tree],
  );

  // Auto-expand root nodes when the tree first loads.
  useEffect(() => {
    if (tree.length === 0) return;
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      for (const root of tree) nextSet.add(root.id);
      return nextSet;
    });
  }, [tree]);

  // ─── Derived: flat list (for the search dropdown + parent picker) ────────
  const flat = useMemo(() => {
    const out: KbCategory[] = [];
    const walk = (nodes: KbCategoryNode[]) => {
      for (const n of nodes) {
        out.push(n);
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const selected = useMemo(() => flat.find((c) => c.id === selectedId) ?? null, [flat, selectedId]);

  // ─── Tree interaction ───────────────────────────────────────────────────
  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Search: filters the tree by name (case-insensitive). Matched nodes +
  // their ancestors are shown; everything else is hidden.
  const filteredTree = useMemo(() => {
    if (!search.trim()) return tree;
    const q = search.toLowerCase();
    const filter = (nodes: KbCategoryNode[]): KbCategoryNode[] => {
      const out: KbCategoryNode[] = [];
      for (const node of nodes) {
        const matches = node.name.toLowerCase().includes(q) || node.slug.toLowerCase().includes(q);
        const filteredChildren = filter(node.children);
        if (matches || filteredChildren.length > 0) {
          out.push({ ...node, children: filteredChildren });
        }
      }
      return out;
    };
    return filter(tree);
  }, [tree, search]);

  // When searching, auto-expand all visible nodes so matches are shown.
  useEffect(() => {
    if (!search.trim()) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const walk = (nodes: KbCategoryNode[]) => {
        for (const n of nodes) {
          next.add(n.id);
          walk(n.children);
        }
      };
      walk(filteredTree);
      return next;
    });
  }, [search, filteredTree]);

  // ─── Create / Edit modal ────────────────────────────────────────────────
  // `modalDefaultParentId` is the pre-selected parent for create mode
  // (set when the admin clicks "Add Child" on a node). Null = root.
  // The modal reads this via the `defaultParentId` prop on open.
  const [modalDefaultParentId, setModalDefaultParentId] = useState<number | null>(null);

  function openCreate(parentId: number | null) {
    setEditingCategory(null);
    setModalDefaultParentId(parentId);
    setModalOpen(true);
  }

  function openEdit(cat: KbCategory) {
    setEditingCategory(cat);
    setModalDefaultParentId(null);
    setModalOpen(true);
  }

  function handleSaved() {
    refetch();
    toast.success(editingCategory ? "Category updated" : "Category created");
  }

  // ─── Move modal ─────────────────────────────────────────────────────────
  function openMove(cat: KbCategory) {
    setMoveTarget(cat);
    setMoveParentId(cat.parentId);
    setError("");
  }

  // Build the parent-options list for the move modal (excludes the moved
  // node + its descendants — same cycle-prevention as the create modal).
  const moveParentOptions = useMemo(() => {
    if (!moveTarget) return [];
    const options: { id: number; label: string; depth: number }[] = [];
    const skipPath = moveTarget.path;
    const walk = (nodes: KbCategoryNode[], depth: number) => {
      for (const node of nodes) {
        if (node.path === skipPath || node.path.startsWith(skipPath)) continue;
        options.push({ id: node.id, label: node.name, depth });
        walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return options;
  }, [tree, moveTarget]);

  async function handleMoveSubmit() {
    if (!moveTarget) return;
    setSaving(true);
    setError("");
    try {
      await moveKbCategory(apiFetch, moveTarget.id, moveParentId);
      toast.success("Category moved");
      setMoveTarget(null);
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move category.");
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete confirmation ────────────────────────────────────────────────
  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deleteKbCategory(apiFetch, deleteTarget.id);
      toast.success("Category deleted");
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete category.");
    } finally {
      setSaving(false);
    }
  }

  // ─── Inline edit (right panel) ──────────────────────────────────────────
  // The right panel is a quick-edit form for the selected category. It
  // mirrors the modal's fields but without the parent dropdown (parent
  // changes go through the Move modal). Saving calls updateKbCategory.
  const [inlineName, setInlineName] = useState("");
  const [inlineSlug, setInlineSlug] = useState("");
  const [inlineSlugEdited, setInlineSlugEdited] = useState(false);
  const [inlineDescription, setInlineDescription] = useState("");
  const [inlineIsActive, setInlineIsActive] = useState(true);
  const [inlineSaving, setInlineSaving] = useState(false);

  // Sync the inline form with the selected category.
  useEffect(() => {
    if (!selected) return;
    setInlineName(selected.name);
    setInlineSlug(selected.slug);
    setInlineSlugEdited(true);
    setInlineDescription(selected.description ?? "");
    setInlineIsActive(selected.isActive);
  }, [selected]);

  function handleInlineNameChange(next: string) {
    setInlineName(next);
    if (!inlineSlugEdited) setInlineSlug(autoSlug(next));
  }

  function handleInlineSlugChange(next: string) {
    setInlineSlugEdited(true);
    setInlineSlug(next.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  }

  async function handleInlineSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setInlineSaving(true);
    try {
      await updateKbCategory(apiFetch, selected.id, {
        name: inlineName.trim(),
        slug: inlineSlug.trim(),
        description: inlineDescription.trim() || null,
        isActive: inlineIsActive,
      });
      toast.success("Saved");
      refetch(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setInlineSaving(false);
    }
  }

  // ─── Loading state ──────────────────────────────────────────────────────
  if (treeLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Knowledge Base
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Curated plant-care content the AI uses as its primary information source. Phase 1:
            category tree only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={refreshing}
            className="rounded-xl"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => openCreate(null)}
            className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Add Root Category
          </Button>
        </div>
      </div>

      {tree.length === 0 ? (
        <EmptyState onCreate={() => openCreate(null)} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Left: tree */}
          <div className="lg:col-span-3 bg-card rounded-2xl border overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/30">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search categories by name or slug…"
                className="rounded-xl bg-background"
              />
            </div>
            <div className="p-2 max-h-[70vh] overflow-y-auto">
              <TreeView
                nodes={filteredTree}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={toggleExpand}
                onSelect={setSelectedId}
                onAddChild={(cat) => openCreate(cat.id)}
                onEdit={openEdit}
                onMove={openMove}
                onDelete={setDeleteTarget}
              />
              {filteredTree.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No categories match "{search}".
                </p>
              )}
            </div>
          </div>

          {/* Right: details + inline edit */}
          <div className="lg:col-span-2">
            {selected ? (
              <form
                onSubmit={handleInlineSubmit}
                className="bg-card rounded-2xl border p-5 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Details</h3>
                  <Badge variant={selected.isActive ? "default" : "secondary"}>
                    {selected.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>

                <div>
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Name
                  </Label>
                  <Input
                    value={inlineName}
                    onChange={(e) => handleInlineNameChange(e.target.value)}
                    required
                    maxLength={100}
                    className="mt-1.5 rounded-xl"
                  />
                </div>

                <div>
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Slug
                  </Label>
                  <Input
                    value={inlineSlug}
                    onChange={(e) => handleInlineSlugChange(e.target.value)}
                    required
                    maxLength={80}
                    className="mt-1.5 rounded-xl font-mono text-sm"
                  />
                </div>

                <div>
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Description
                  </Label>
                  <Textarea
                    value={inlineDescription}
                    onChange={(e) => setInlineDescription(e.target.value)}
                    maxLength={500}
                    rows={3}
                    className="mt-1.5 rounded-xl"
                  />
                </div>

                <div className="flex items-center justify-between rounded-xl border p-3">
                  <div>
                    <Label className="text-sm font-medium">Active</Label>
                    <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                      Inactive categories are hidden from the AI search tool. Cascades to
                      descendants.
                    </p>
                  </div>
                  <Switch checked={inlineIsActive} onCheckedChange={setInlineIsActive} />
                </div>

                <div className="space-y-1 text-xs text-muted-foreground border-t pt-3">
                  <div className="flex justify-between">
                    <span>Depth</span>
                    <span className="font-mono">{selected.depth}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Path</span>
                    <span className="font-mono text-[10px]">{selected.path}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Entries</span>
                    <span className="font-mono">{selected.entryCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span>{new Date(selected.createdAt).toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <Button
                    type="submit"
                    disabled={inlineSaving}
                    className="flex-1 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
                  >
                    {inlineSaving ? "Saving…" : "Save Changes"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openMove(selected)}
                    className="rounded-xl"
                    title="Move to a different parent"
                  >
                    <ArrowRightCircle className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            ) : (
              <div className="bg-card rounded-2xl border p-8 text-center text-sm text-muted-foreground">
                <Folder className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
                Select a category from the tree to view + edit its details.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      <KbCategoryModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        category={editingCategory}
        tree={tree}
        defaultParentId={modalDefaultParentId}
        onSaved={handleSaved}
      />

      {/* Move modal */}
      <Dialog open={moveTarget !== null} onOpenChange={(o) => !o && setMoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move "{moveTarget?.name}"</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a new parent. The category and all its descendants will move (their paths +
              depths are rebuilt automatically).
            </p>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                New Parent
              </Label>
              <Select
                value={moveParentId === null ? "__root__" : String(moveParentId)}
                onValueChange={(v) => setMoveParentId(v === "__root__" ? null : Number(v))}
              >
                <SelectTrigger className="mt-1.5 rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__root__">— Root (no parent) —</SelectItem>
                  {moveParentOptions.map((opt) => (
                    <SelectItem key={opt.id} value={String(opt.id)}>
                      {"\u00A0".repeat(opt.depth * 2)}
                      {opt.depth > 0 ? "↳ " : ""}
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && (
              <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMoveTarget(null)}
              disabled={saving}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              onClick={handleMoveSubmit}
              disabled={saving}
              className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? "Moving…" : "Move Category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This will permanently delete the category{" "}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span> and{" "}
              <span className="font-medium">all its descendants</span> (cascading delete).
            </p>
            <div className="rounded-xl bg-warning/10 border border-warning/20 px-3 py-2 text-warning flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                If any category in this subtree has KB entries, the delete will be rejected. Move or
                delete the entries first.
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={saving}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={saving}
              className="rounded-xl"
            >
              {saving ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── TreeView (recursive) ────────────────────────────────────────────────────

function TreeView({
  nodes,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  onAddChild,
  onEdit,
  onMove,
  onDelete,
}: {
  nodes: KbCategoryNode[];
  expanded: Set<number>;
  selectedId: number | null;
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
  onAddChild: (cat: KbCategory) => void;
  onEdit: (cat: KbCategory) => void;
  onMove: (cat: KbCategory) => void;
  onDelete: (cat: KbCategory) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          expanded={expanded}
          selectedId={selectedId}
          onToggle={onToggle}
          onSelect={onSelect}
          onAddChild={onAddChild}
          onEdit={onEdit}
          onMove={onMove}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  onAddChild,
  onEdit,
  onMove,
  onDelete,
}: {
  node: KbCategoryNode;
  expanded: Set<number>;
  selectedId: number | null;
  onToggle: (id: number) => void;
  onSelect: (id: number) => void;
  onAddChild: (cat: KbCategory) => void;
  onEdit: (cat: KbCategory) => void;
  onMove: (cat: KbCategory) => void;
  onDelete: (cat: KbCategory) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors ${
          isSelected ? "bg-primary/10" : "hover:bg-muted/60"
        }`}
      >
        {/* Expand / collapse arrow */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          className={`p-0.5 rounded transition-colors ${
            hasChildren ? "hover:bg-muted" : "opacity-0 pointer-events-none"
          }`}
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Folder icon */}
        {isOpen && hasChildren ? (
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        )}

        {/* Name + entry count badge */}
        <button
          onClick={() => onSelect(node.id)}
          className="flex-1 text-left text-sm truncate flex items-center gap-2"
        >
          <span className={isSelected ? "font-medium text-primary" : ""}>{node.name}</span>
          {node.entryCount > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {node.entryCount}
            </Badge>
          )}
          {!node.isActive && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              Inactive
            </Badge>
          )}
        </button>

        {/* Hover actions */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
          <IconButton onClick={() => onAddChild(node)} title="Add child category">
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => onEdit(node)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => onMove(node)} title="Move">
            <ArrowRightCircle className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => onDelete(node)} title="Delete" danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* Children (recursive) */}
      {isOpen && hasChildren && (
        <ul className="ml-4 border-l border-border/60 pl-1.5 space-y-0.5">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              expanded={expanded}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onMove={onMove}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function IconButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={`p-1 rounded-md transition-colors ${
        danger
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-muted hover:text-foreground"
      } text-muted-foreground`}
    >
      {children}
    </button>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-card rounded-2xl border p-12 text-center">
      <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
      <p className="font-semibold text-muted-foreground mb-1">No categories yet</p>
      <p className="text-sm text-muted-foreground/70 mb-4">
        Create your first KB category to start organizing plant-care content for the AI.
      </p>
      <Button
        onClick={onCreate}
        className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
      >
        <Plus className="h-4 w-4" />
        Create First Category
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 2: KbSourcesView ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sources view — list + upload + detail.
 *
 * List mode: paginated table of sources with filters (creator, language,
 * status). Click a row to open detail mode.
 *
 * Detail mode: shows source metadata + raw text (collapsible) + chunking
 * section (AI Chunk button for English, Add Manual Entry for all) + the
 * source's entries (with edit/activate/deactivate/delete).
 */
function KbSourcesView({
  tree,
  creators,
  refetchCreators,
}: {
  tree: KbCategoryNode[];
  creators: KbCreator[];
  refetchCreators: () => Promise<void>;
}) {
  const apiFetch = useApiFetch();
  const [sources, setSources] = useState<KbSource[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0); // 0-indexed
  const [selectedSource, setSelectedSource] = useState<KbSourceWithEntries | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [chunkReviewOpen, setChunkReviewOpen] = useState(false);
  const [chunkResult, setChunkResult] = useState<KbChunkResult | null>(null);
  const [chunking, setChunking] = useState(false);
  const [entryEditorOpen, setEntryEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KbEntry | null>(null);
  const [editingSource, setEditingSource] = useState<KbSource | null>(null);

  const PAGE_SIZE = 20;

  const refetchList = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchKbSources(apiFetch, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setSources(result.sources);
      setTotal(result.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load sources");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page]);

  useEffect(() => {
    refetchList();
  }, [refetchList]);

  const refetchDetail = useCallback(
    async (id: number) => {
      try {
        const s = await fetchKbSource(apiFetch, id);
        setSelectedSource(s);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load source");
      }
    },
    [apiFetch],
  );

  async function handleChunk(source: KbSource) {
    setChunking(true);
    try {
      const result = await chunkSourceWithAI(apiFetch, source.id);
      setChunkResult(result);
      setChunkReviewOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI chunking failed");
    } finally {
      setChunking(false);
    }
  }

  async function handleDeleteSource(id: number) {
    if (!confirm("Delete this source + all its entries? This cannot be undone.")) return;
    try {
      await deleteKbSource(apiFetch, id);
      toast.success("Source deleted");
      setSelectedSource(null);
      refetchList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete source");
    }
  }

  async function handleToggleActive(entry: KbEntry) {
    try {
      if (entry.isActive) {
        await deactivateKbEntry(apiFetch, entry.id);
      } else {
        await activateKbEntry(apiFetch, entry.id);
      }
      if (selectedSource) await refetchDetail(selectedSource.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle entry");
    }
  }

  async function handleDeleteEntry(id: number) {
    if (!confirm("Delete this entry? This cannot be undone.")) return;
    try {
      await deleteKbEntry(apiFetch, id);
      toast.success("Entry deleted");
      if (selectedSource) await refetchDetail(selectedSource.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete entry");
    }
  }

  // ─── Detail mode ─────────────────────────────────────────────────────────
  if (selectedSource) {
    const s = selectedSource;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedSource(null);
              refetchList();
            }}
            className="rounded-xl"
          >
            ← Back to Sources
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingSource(s)}
              className="rounded-xl"
            >
              <Pencil className="h-4 w-4" />
              Edit Source
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDeleteSource(s.id)}
              className="rounded-xl text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete Source
            </Button>
          </div>
        </div>

        {/* Metadata */}
        <div className="bg-card rounded-2xl border p-5 space-y-2">
          <h3 className="font-semibold text-lg">{s.sourceTitle}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <span className="text-xs text-muted-foreground uppercase">Type</span>
              <p>{s.sourceType}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground uppercase">Language</span>
              <p>{s.sourceLanguage}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground uppercase">Status</span>
              <p>
                <Badge
                  variant={
                    s.processingStatus === "ready"
                      ? "default"
                      : s.processingStatus === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {s.processingStatus}
                </Badge>
              </p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground uppercase">Entries</span>
              <p>{s.entryCount}</p>
            </div>
            {s.sourceUrl && (
              <div className="col-span-2 md:col-span-4">
                <span className="text-xs text-muted-foreground uppercase">URL</span>
                <a
                  href={s.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm text-primary hover:underline truncate"
                >
                  {s.sourceUrl}
                </a>
              </div>
            )}
            {s.creator && (
              <div className="col-span-2 md:col-span-4">
                <span className="text-xs text-muted-foreground uppercase">Creator</span>
                <p>
                  {s.creator.name} ({s.creator.sourceType})
                </p>
              </div>
            )}
            {s.chunkingMethod && (
              <div className="col-span-2 md:col-span-4">
                <span className="text-xs text-muted-foreground uppercase">Chunking</span>
                <p className="text-sm">
                  {s.chunkingMethod} ({s.chunkingModel ?? "n/a"}) —{" "}
                  {s.chunkedAt ? new Date(s.chunkedAt).toLocaleString() : "—"}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Chunking section */}
        <div className="bg-card rounded-2xl border p-5 space-y-3">
          <h4 className="font-medium">Chunking</h4>
          {s.sourceLanguage === "en" ? (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => handleChunk(s)}
                disabled={chunking}
                className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {chunking
                  ? "Chunking…"
                  : s.chunkingMethod === "ai"
                    ? "Re-chunk with AI"
                    : "AI Chunk"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setEditingEntry(null);
                  setEntryEditorOpen(true);
                }}
                className="rounded-xl"
              >
                <Plus className="h-4 w-4" />
                Add Manual Entry
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">
                AI chunking is English-only. Create entries manually:
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setEditingEntry(null);
                  setEntryEditorOpen(true);
                }}
                className="rounded-xl"
              >
                <Plus className="h-4 w-4" />
                Add Manual Entry
              </Button>
            </div>
          )}
          {s.chunkingError && (
            <p className="text-sm text-destructive">Chunking error: {s.chunkingError}</p>
          )}
        </div>

        {/* Entries for this source */}
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="px-5 py-3 border-b">
            <h4 className="font-medium">Entries ({s.entries.length})</h4>
          </div>
          {s.entries.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground text-center">
              No entries yet.{" "}
              {s.sourceLanguage === "en"
                ? "Use AI Chunk or Add Manual Entry above."
                : "Use Add Manual Entry above."}
            </p>
          ) : (
            <div className="divide-y">
              {s.entries.map((entry) => (
                <div key={entry.id} className="px-5 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{entry.title}</span>
                      <Badge
                        variant={entry.isActive ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {entry.isActive ? "Active" : "Inactive"}
                      </Badge>
                      <Badge
                        variant={
                          entry.embeddingStatus === "generated"
                            ? "default"
                            : entry.embeddingStatus === "pending"
                              ? "secondary"
                              : "destructive"
                        }
                        className="text-[10px]"
                      >
                        emb: {entry.embeddingStatus}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {entry.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(entry)}
                      className="h-8 px-2"
                      title={entry.isActive ? "Deactivate" : "Activate"}
                    >
                      <Switch checked={entry.isActive} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingEntry(entry);
                        setEntryEditorOpen(true);
                      }}
                      className="h-8 px-2"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteEntry(entry.id)}
                      className="h-8 px-2 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Raw text (collapsible) */}
        <details className="bg-card rounded-2xl border p-5">
          <summary className="cursor-pointer font-medium">
            Raw Text ({s.rawText.length.toLocaleString()} chars)
          </summary>
          <pre className="mt-3 text-xs whitespace-pre-wrap font-mono max-h-96 overflow-y-auto bg-muted/30 p-3 rounded-lg">
            {s.rawText}
          </pre>
        </details>

        {/* Modals */}
        <KbChunkReviewModal
          open={chunkReviewOpen}
          onOpenChange={setChunkReviewOpen}
          source={s}
          chunks={chunkResult?.chunks ?? []}
          model={chunkResult?.model ?? ""}
          categoryTree={tree}
          onCreated={() => refetchDetail(s.id)}
        />
        <KbEntryEditorModal
          open={entryEditorOpen}
          onOpenChange={setEntryEditorOpen}
          entry={editingEntry}
          sourceId={s.id}
          categoryTree={tree}
          onSaved={() => refetchDetail(s.id)}
        />
        <KbSourceEditModal
          source={editingSource}
          creators={creators}
          onCreated={refetchCreators}
          onSaved={() => {
            // Refresh the detail view with the updated source, and clear
            // the editing state so the modal closes. We don't use the
            // returned `updated` source directly — we re-fetch from the
            // server to get the fully-populated KbSourceWithEntries (the
            // updateKbSource response is a plain KbSource without entries).
            refetchDetail(s.id);
            setEditingSource(null);
            // Also refresh the list (the title/URL may have changed,
            // which affects the list view).
            refetchList();
            toast.success("Source updated");
          }}
          onOpenChange={(open) => {
            if (!open) setEditingSource(null);
          }}
        />
      </div>
    );
  }

  // ─── List mode ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sources</h2>
        <Button
          onClick={() => setUploadOpen(true)}
          className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          Upload Source
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <div className="bg-card rounded-2xl border p-12 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="font-semibold text-muted-foreground mb-1">No sources yet</p>
          <p className="text-sm text-muted-foreground/70 mb-4">
            Upload your first source (YouTube transcript, blog post, manual content) to start
            building the KB.
          </p>
          <Button
            onClick={() => setUploadOpen(true)}
            className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Upload First Source
          </Button>
        </div>
      ) : (
        <>
          <div className="bg-card rounded-2xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Title
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Type
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Lang
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase">
                    Entries
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sources.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => refetchDetail(s.id)}
                    className="hover:bg-primary/5 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium truncate max-w-xs">{s.sourceTitle}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{s.sourceType}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{s.sourceLanguage}</td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          s.processingStatus === "ready"
                            ? "default"
                            : s.processingStatus === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {s.processingStatus}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">{s.entryCount}</td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-xl"
              >
                ← Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-xl"
              >
                Next →
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Upload modal */}
      <KbSourceUploadModal
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        creators={creators}
        onCreated={refetchCreators}
        onSourceCreated={(s) => {
          refetchList();
          refetchDetail(s.id); // open detail view for the new source
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 2: KbEntriesView ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entries view — paginated list of all KB entries across all sources.
 *
 * Filters: active status, embedding status. Click a row to open the
 * editor modal. "Add Entry" button requires a source — since this view
 * is cross-source, we don't show an "Add" button here (entries are
 * created from the Sources view's detail panel).
 */
function KbEntriesView({ tree }: { tree: KbCategoryNode[] }) {
  const apiFetch = useApiFetch();
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [filterActive, setFilterActive] = useState<"all" | "active" | "inactive">("all");
  const [filterEmbedding, setFilterEmbedding] = useState<
    "all" | "pending" | "generated" | "failed"
  >("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KbEntry | null>(null);

  const PAGE_SIZE = 20;

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchKbEntries(apiFetch, {
        isActive: filterActive === "all" ? undefined : filterActive === "active",
        embeddingStatus: filterEmbedding === "all" ? undefined : filterEmbedding,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load entries");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, filterActive, filterEmbedding]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  async function handleToggleActive(entry: KbEntry) {
    try {
      if (entry.isActive) {
        await deactivateKbEntry(apiFetch, entry.id);
      } else {
        await activateKbEntry(apiFetch, entry.id);
      }
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle entry");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this entry? This cannot be undone.")) return;
    try {
      await deleteKbEntry(apiFetch, id);
      toast.success("Entry deleted");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete entry");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Entries</h2>
        <p className="text-xs text-muted-foreground">
          Entries are created from the Sources tab. Activate entries here to make them available to
          the AI.
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <Select
          value={filterActive}
          onValueChange={(v) => setFilterActive(v as typeof filterActive)}
        >
          <SelectTrigger className="rounded-xl w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All (active+inactive)</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="inactive">Inactive only</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filterEmbedding}
          onValueChange={(v) => setFilterEmbedding(v as typeof filterEmbedding)}
        >
          <SelectTrigger className="rounded-xl w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All embeddings</SelectItem>
            <SelectItem value="pending">Embedding: pending</SelectItem>
            <SelectItem value="generated">Embedding: generated</SelectItem>
            <SelectItem value="failed">Embedding: failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-card rounded-2xl border p-12 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="font-semibold text-muted-foreground mb-1">No entries found</p>
          <p className="text-sm text-muted-foreground/70">
            {filterActive !== "all" || filterEmbedding !== "all"
              ? "Try changing the filters above."
              : "Create entries from the Sources tab (AI chunk or manual entry)."}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-card rounded-2xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Title
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Active
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Embedding
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase">
                    Priority
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Updated
                  </th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-primary/5">
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => {
                          setEditingEntry(entry);
                          setEditorOpen(true);
                        }}
                        className="font-medium text-left truncate max-w-md block hover:text-primary"
                      >
                        {entry.title}
                      </button>
                      {entry.keywords.length > 0 && (
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {entry.keywords.slice(0, 3).map((k) => (
                            <Badge key={k} variant="outline" className="text-[10px] px-1 py-0">
                              {k}
                            </Badge>
                          ))}
                          {entry.keywords.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{entry.keywords.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Switch
                        checked={entry.isActive}
                        onCheckedChange={() => handleToggleActive(entry)}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          entry.embeddingStatus === "generated"
                            ? "default"
                            : entry.embeddingStatus === "pending"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {entry.embeddingStatus}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">{entry.priority}</td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">
                      {new Date(entry.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(entry.id)}
                        className="h-8 px-2 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-xl"
              >
                ← Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-xl"
              >
                Next →
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Editor modal (edit mode only — creation is from Sources view) */}
      <KbEntryEditorModal
        open={editorOpen}
        onOpenChange={setEditorOpen}
        entry={editingEntry}
        sourceId={editingEntry?.sourceId ?? null}
        categoryTree={tree}
        onSaved={() => {
          setEditorOpen(false);
          refetch();
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 3: KbInsightsView ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * KB Insights view — admin dashboard for monitoring KB usage.
 *
 * Shows:
 *   - Stat cards: Total Entries, Active Entries, Entries with Embeddings,
 *     KB Hit Rate (30 days).
 *   - Entries per category (horizontal bar chart — top 10).
 *   - Entries per creator (horizontal bar chart — top 10).
 *   - Search tester: a text input + "Search" button that calls
 *     POST /api/ai/admin/kb/search + shows results with scores + breakdown.
 *
 * Data is fetched on mount + on "Refresh" button click. The search tester
 * has its own state (query + results) so it doesn't refetch the stats.
 */
function KbInsightsView() {
  const apiFetch = useApiFetch();
  const [insights, setInsights] = useState<KbInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Search tester state.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KbSearchTestResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchKbInsights(apiFetch);
      setInsights(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load KB insights");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError("");
    try {
      const result = await testKbSearch(apiFetch, searchQuery.trim(), { maxResults: 10 });
      setSearchResults(result);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="bg-card rounded-2xl border p-8 text-center text-sm text-muted-foreground">
        Failed to load insights.{" "}
        <button onClick={refetch} className="text-primary hover:underline">
          Try again
        </button>
      </div>
    );
  }

  const maxCategoryCount = Math.max(...insights.entriesByCategory.map((c) => c.count), 1);
  const maxCreatorCount = Math.max(...insights.entriesByCreator.map((c) => c.count), 1);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">KB Insights</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={refetch}
          disabled={refreshing}
          className="rounded-xl"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Total Entries"
          value={insights.totalEntries}
          icon={<BookOpen className="h-5 w-5" />}
        />
        <StatCard
          label="Active Entries"
          value={insights.activeEntries}
          icon={<BookOpen className="h-5 w-5" />}
          subtitle={`${insights.totalEntries > 0 ? Math.round((insights.activeEntries / insights.totalEntries) * 100) : 0}% of total`}
        />
        <StatCard
          label="With Embeddings"
          value={insights.entriesWithEmbeddings}
          icon={<Sparkles className="h-5 w-5" />}
          subtitle={`${insights.totalEntries > 0 ? Math.round((insights.entriesWithEmbeddings / insights.totalEntries) * 100) : 0}% of total`}
        />
        <StatCard
          label="KB Hit Rate (30d)"
          value={`${insights.hitRate.hitRatePercent}%`}
          icon={<TrendingUp className="h-5 w-5" />}
          subtitle={`${insights.hitRate.kbHits} / ${insights.hitRate.totalAssistantMessages} responses`}
        />
      </div>

      {/* Hit rate breakdown */}
      <div className="bg-card rounded-2xl border p-5">
        <h3 className="font-medium mb-3">KB Usage (Last 30 Days)</h3>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-2xl font-bold text-primary">{insights.hitRate.kbHits}</p>
            <p className="text-xs text-muted-foreground">KB hits (injected or tool called)</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{insights.hitRate.contextInjected}</p>
            <p className="text-xs text-muted-foreground">Auto-injected into prompt</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-primary">{insights.hitRate.toolCalls}</p>
            <p className="text-xs text-muted-foreground">AI called search tool</p>
          </div>
        </div>
      </div>

      {/* Bar charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Entries by category */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-medium mb-3">Entries by Category</h3>
          {insights.entriesByCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No categories yet.</p>
          ) : (
            <div className="space-y-2">
              {insights.entriesByCategory.map((c) => (
                <div key={c.categoryName} className="flex items-center gap-2 text-sm">
                  <span className="w-32 truncate text-muted-foreground">{c.categoryName}</span>
                  <div className="flex-1 h-6 bg-muted rounded-md overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-md transition-all"
                      style={{ width: `${(c.count / maxCategoryCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-xs">{c.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Entries by creator */}
        <div className="bg-card rounded-2xl border p-5">
          <h3 className="font-medium mb-3">Entries by Creator</h3>
          {insights.entriesByCreator.length === 0 ? (
            <p className="text-sm text-muted-foreground">No creators yet.</p>
          ) : (
            <div className="space-y-2">
              {insights.entriesByCreator.map((c) => (
                <div key={c.creatorName} className="flex items-center gap-2 text-sm">
                  <span className="w-32 truncate text-muted-foreground">{c.creatorName}</span>
                  <div className="flex-1 h-6 bg-muted rounded-md overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-md transition-all"
                      style={{ width: `${(c.count / maxCreatorCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-xs">{c.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search tester */}
      <div className="bg-card rounded-2xl border p-5 space-y-3">
        <div>
          <h3 className="font-medium">Search Tester</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Test the KB search engine. See what results the AI would get + the score breakdown for
            each.
          </p>
        </div>
        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="e.g. mango watering summer"
            className="rounded-xl flex-1"
            maxLength={200}
          />
          <Button
            type="submit"
            disabled={searching || !searchQuery.trim()}
            className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>

        {searchError && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{searchError}</span>
          </div>
        )}

        {searchResults && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {searchResults.count} result{searchResults.count === 1 ? "" : "s"} for "
              {searchResults.query}"
            </p>
            {searchResults.results.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No results. The KB may be empty or no entries match this query.
              </p>
            ) : (
              <div className="space-y-2">
                {searchResults.results.map((r, idx) => (
                  <div key={r.id} className="rounded-xl border p-3 space-y-2 bg-muted/20">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">
                          <span className="text-muted-foreground">#{idx + 1}</span> {r.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {r.creator && `${r.creator} · `}
                          {r.category && `${r.category} · `}
                          {r.source && `${r.source}`}
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        score: {r.score}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{r.content}</p>
                    {/* Score breakdown */}
                    <div className="grid grid-cols-5 gap-1 text-[10px]">
                      <ScoreBar label="Semantic" value={r.breakdown.semantic} weight="40%" />
                      <ScoreBar label="Keyword" value={r.breakdown.keyword} weight="20%" />
                      <ScoreBar label="Authority" value={r.breakdown.authority} weight="20%" />
                      <ScoreBar label="Priority" value={r.breakdown.priority} weight="10%" />
                      <ScoreBar label="Recency" value={r.breakdown.recency} weight="10%" />
                    </div>
                    {r.keywords.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {r.keywords.map((k) => (
                          <Badge key={k} variant="outline" className="text-[10px] px-1.5 py-0">
                            {k}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helper components for the insights view ─────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  subtitle,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="bg-card rounded-2xl border p-4 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subtitle && <p className="text-[11px] text-muted-foreground/70">{subtitle}</p>}
    </div>
  );
}

function ScoreBar({ label, value, weight }: { label: string; value: number; weight: string }) {
  // Color: green for high scores, yellow for medium, red for low.
  const color =
    value >= 0.7 ? "bg-green-500/70" : value >= 0.4 ? "bg-yellow-500/70" : "bg-red-500/50";
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value.toFixed(2)}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${value * 100}%` }}
        />
      </div>
      <p className="text-[9px] text-muted-foreground/60 text-center">w: {weight}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Phase 4: KbToneView ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tone profile management view — shows a table of all creators with their
 * tone profile status (eligible / generated / needs-regeneration / match %).
 *
 * Features:
 *   - "Generate All Pending" button (triggers generation for all eligible
 *     creators without profiles — the background job handles this, but the
 *     admin can force it).
 *   - Per-creator "View" button → opens KbToneProfileModal.
 *   - Per-creator "Regenerate" button → calls generateToneProfile.
 *   - Per-creator "Edit %" inline input → set tone_match_percentage.
 */
function KbToneView() {
  const apiFetch = useApiFetch();
  const [status, setStatus] = useState<KbToneProfilesStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profileModalCreator, setProfileModalCreator] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [regeneratingIds, setRegeneratingIds] = useState<Set<number>>(new Set());
  const [editingPct, setEditingPct] = useState<number | null>(null);
  const [pctInput, setPctInput] = useState("");

  const refetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchToneProfileStatus(apiFetch);
      setStatus(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load tone profile status");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  async function handleRegenerate(creator: KbToneProfileStatus) {
    setRegeneratingIds((prev) => new Set(prev).add(creator.id));
    try {
      await generateToneProfile(apiFetch, creator.id);
      toast.success(`Tone profile generated for ${creator.name}`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate");
    } finally {
      setRegeneratingIds((prev) => {
        const next = new Set(prev);
        next.delete(creator.id);
        return next;
      });
    }
  }

  async function handleGenerateAllPending() {
    if (!status) return;
    const pending = status.creators.filter((c) => c.toneMatchEligible && !c.hasProfile);
    if (pending.length === 0) {
      toast.info("No eligible creators without profiles.");
      return;
    }
    toast.info(`Generating ${pending.length} tone profiles…`);
    let succeeded = 0;
    let failed = 0;
    for (const c of pending) {
      try {
        await generateToneProfile(apiFetch, c.id);
        succeeded++;
      } catch {
        failed++;
      }
    }
    toast.success(`Generated ${succeeded} profiles${failed > 0 ? `, ${failed} failed` : ""}`);
    refetch();
  }

  async function handleSavePct(creatorId: number) {
    const trimmed = pctInput.trim();
    let pct: number | null = null;
    if (trimmed === "" || trimmed.toLowerCase() === "default") {
      pct = null; // reset to global default
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        toast.error("Percentage must be 0-100 or 'default'");
        return;
      }
      pct = Math.round(n);
    }
    try {
      await setToneMatchPercentage(apiFetch, creatorId, pct);
      toast.success(`Match % set to ${pct === null ? "default" : pct + "%"}`);
      setEditingPct(null);
      setPctInput("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set percentage");
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="bg-card rounded-2xl border p-8 text-center text-sm text-muted-foreground">
        Failed to load tone profile status.{" "}
        <button onClick={refetch} className="text-primary hover:underline">
          Try again
        </button>
      </div>
    );
  }

  const eligibleCount = status.creators.filter((c) => c.toneMatchEligible).length;
  const generatedCount = status.creators.filter((c) => c.hasProfile).length;
  const needsRegenCount = status.creators.filter((c) => c.needsRegeneration).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Tone Profiles</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Threshold: {status.threshold} entries · Default match: {status.defaultPercentage}% ·
            Regen delta: {status.regenerationDelta} entries
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            disabled={refreshing}
            className="rounded-xl"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleGenerateAllPending}
            className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Sparkles className="h-4 w-4" />
            Generate All Pending
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card rounded-2xl border p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Total Creators
          </p>
          <p className="text-2xl font-bold mt-1">{status.creators.length}</p>
        </div>
        <div className="bg-card rounded-2xl border p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Eligible ({status.threshold}+)
          </p>
          <p className="text-2xl font-bold mt-1">{eligibleCount}</p>
        </div>
        <div className="bg-card rounded-2xl border p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Profiles Generated
          </p>
          <p className="text-2xl font-bold mt-1">{generatedCount}</p>
        </div>
        <div className="bg-card rounded-2xl border p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Needs Regen
          </p>
          <p className="text-2xl font-bold mt-1 text-amber-600 dark:text-amber-400">
            {needsRegenCount}
          </p>
        </div>
      </div>

      {/* Creators table */}
      {status.creators.length === 0 ? (
        <div className="bg-card rounded-2xl border p-12 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="font-semibold text-muted-foreground mb-1">No creators with entries yet</p>
          <p className="text-sm text-muted-foreground/70">
            Upload sources + create entries (Phase 2) to populate the KB. Creators with{" "}
            {status.threshold}+ entries become eligible for tone matching.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Creator
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase">
                    Entries
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-muted-foreground uppercase">
                    Eligible
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-muted-foreground uppercase">
                    Profile
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-muted-foreground uppercase">
                    Match %
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase">
                    Last Generated
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {status.creators.map((c) => (
                  <tr key={c.id} className="hover:bg-primary/5">
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    <td className="px-4 py-2.5 text-right">{c.entryCount}</td>
                    <td className="px-4 py-2.5 text-center">
                      {c.toneMatchEligible ? (
                        <span className="text-green-600 dark:text-green-400">✓</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {c.hasProfile ? (
                        c.needsRegeneration ? (
                          <Badge variant="destructive" className="text-[10px]">
                            ⚠ Regen
                          </Badge>
                        ) : (
                          <Badge variant="default" className="text-[10px]">
                            ✓ Ready
                          </Badge>
                        )
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          {c.toneMatchEligible ? "Pending" : "N/A"}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {editingPct === c.id ? (
                        <div className="flex items-center gap-1 justify-center">
                          <Input
                            type="text"
                            value={pctInput}
                            onChange={(e) => setPctInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSavePct(c.id);
                              if (e.key === "Escape") {
                                setEditingPct(null);
                                setPctInput("");
                              }
                            }}
                            placeholder={`${c.effectivePercentage}`}
                            className="h-7 w-16 rounded-lg text-xs text-center"
                            autoFocus
                          />
                          <button
                            onClick={() => handleSavePct(c.id)}
                            className="text-xs text-primary hover:underline"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingPct(c.id);
                            setPctInput(
                              c.toneMatchPercentage !== null ? String(c.toneMatchPercentage) : "",
                            );
                          }}
                          className="text-sm hover:text-primary hover:underline"
                          title="Click to edit"
                        >
                          {c.toneMatchPercentage !== null
                            ? `${c.toneMatchPercentage}%`
                            : `${c.effectivePercentage}% (default)`}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">
                      {c.lastGeneratedAt ? new Date(c.lastGeneratedAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setProfileModalCreator({ id: c.id, name: c.name })}
                          className="text-xs text-primary hover:underline px-1.5"
                          title="View profile"
                        >
                          View
                        </button>
                        {c.toneMatchEligible && (
                          <button
                            onClick={() => handleRegenerate(c)}
                            disabled={regeneratingIds.has(c.id)}
                            className="text-xs text-muted-foreground hover:text-foreground px-1.5 disabled:opacity-50"
                            title="Regenerate profile"
                          >
                            {regeneratingIds.has(c.id) ? "…" : "Regen"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Profile viewer modal */}
      <KbToneProfileModal
        open={profileModalCreator !== null}
        onOpenChange={(o) => !o && setProfileModalCreator(null)}
        creatorId={profileModalCreator?.id ?? null}
        creatorName={profileModalCreator?.name ?? ""}
        onRegenerated={refetch}
      />
    </div>
  );
}
