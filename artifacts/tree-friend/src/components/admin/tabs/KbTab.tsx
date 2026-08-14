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
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchKbCategoryTree,
  updateKbCategory,
  moveKbCategory,
  deleteKbCategory,
  autoSlug,
  type KbCategory,
  type KbCategoryNode,
} from "@/lib/kbApi";
import { KbCategoryModal } from "@/components/admin/modals/KbCategoryModal";

/**
 * Knowledge Base admin tab.
 *
 * Layout:
 *   - Top toolbar: title, "Add Root Category" button, refresh button.
 *   - Left panel:  collapsible category tree (with expand/collapse arrows
 *                  + per-node actions: Add Child, Edit, Move, Delete).
 *   - Right panel: details + inline edit form for the selected category
 *                  (name, slug, description, active toggle, depth, path,
 *                  entryCount, dates).
 *   - Empty state: friendly prompt to create the first category.
 *
 * Phase 1 scope: category CRUD + tree management only. No entries, no
 * sources, no AI integration — those land in Phases 2-4.
 *
 * Data flow:
 *   - On mount + on refresh: GET /api/ai/admin/kb/categories/tree
 *   - Create / Edit: opens KbCategoryModal → on save, refetch the tree.
 *   - Move: opens a small modal with a parent dropdown → on save, refetch.
 *   - Delete: confirmation dialog → on confirm, DELETE → refetch.
 *
 * The tree is fetched as a nested structure (server-side build) and
 * rendered recursively. Expand/collapse state is local (a Set of ids).
 */
export function KbTab() {
  const apiFetch = useApiFetch();
  const [tree, setTree] = useState<KbCategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
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
  const refetch = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const next = await fetchKbCategoryTree(apiFetch);
      setTree(next);
      // Auto-expand all root nodes on first load so the tree is browsable.
      setExpanded((prev) => {
        const nextSet = new Set(prev);
        for (const root of next) nextSet.add(root.id);
        return nextSet;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load KB categories");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);

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

  const selected = useMemo(
    () => flat.find((c) => c.id === selectedId) ?? null,
    [flat, selectedId],
  );

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
  if (loading) {
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
            Curated plant-care content the AI uses as its primary information source. Phase 1: category tree only.
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
                      Inactive categories are hidden from the AI search tool. Cascades to descendants.
                    </p>
                  </div>
                  <Switch
                    checked={inlineIsActive}
                    onCheckedChange={setInlineIsActive}
                  />
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
              Select a new parent. The category and all its descendants will move
              (their paths + depths are rebuilt automatically).
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
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>{" "}
              and <span className="font-medium">all its descendants</span> (cascading delete).
            </p>
            <div className="rounded-xl bg-warning/10 border border-warning/20 px-3 py-2 text-warning flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                If any category in this subtree has KB entries, the delete will be
                rejected. Move or delete the entries first.
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
          <span className={isSelected ? "font-medium text-primary" : ""}>
            {node.name}
          </span>
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
          <IconButton
            onClick={() => onAddChild(node)}
            title="Add child category"
          >
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => onEdit(node)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={() => onMove(node)} title="Move">
            <ArrowRightCircle className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            onClick={() => onDelete(node)}
            title="Delete"
            danger
          >
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
