import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { useApiFetch } from "@/lib/useApiFetch";
import {
  createKbCategory,
  updateKbCategory,
  autoSlug,
  type KbCategory,
  type KbCategoryNode,
} from "@/lib/kbApi";

/**
 * Create / Edit modal for a single KB category.
 *
 * Fields:
 *   - name        (required, 1-100 chars)
 *   - slug        (required, /^[a-z0-9-]+$/, max 80; auto-generated from name)
 *   - description (optional, max 500 chars)
 *   - parent      (dropdown of existing categories; "Root (no parent)" for null)
 *   - isActive    (only shown in edit mode — new categories are always active)
 *
 * The parent dropdown shows a flat indented list (depth-based indentation)
 * derived from the `tree` prop. We exclude the category being edited +
 * its descendants from the parent options (you can't move a category into
 * its own subtree — that would create a cycle).
 *
 * On submit:
 *   - Create mode: POST /api/ai/admin/kb/categories
 *   - Edit mode:   PUT  /api/ai/admin/kb/categories/:id
 *
 * Note: parent changes in edit mode are deferred to the Move modal in the
 * KbTab (which uses POST /:id/move). The parent dropdown is only shown in
 * CREATE mode here — editing the parent of an existing category has
 * cascading path implications, so we keep it as a separate intentional
 * action. (The PUT endpoint doesn't accept parentId; that's enforced
 * server-side too.)
 */
export function KbCategoryModal({
  open,
  onOpenChange,
  category, // null = create mode; object = edit mode
  tree, // current category tree (for the parent dropdown)
  defaultParentId, // optional: pre-selected parent for create mode (ignored in edit mode)
  onSaved, // callback after successful create/update (caller refetches)
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: KbCategory | null;
  tree: KbCategoryNode[];
  defaultParentId?: number | null;
  onSaved: () => void;
}) {
  const apiFetch = useApiFetch();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset the form whenever the modal opens (or the category prop changes).
  // In create mode (category === null) we clear everything; in edit mode
  // we pre-fill from the category. In create mode, if `defaultParentId` is
  // provided (e.g. the admin clicked "Add Child" on a node), we pre-select
  // that parent — otherwise we default to root.
  useEffect(() => {
    if (!open) return;
    setError("");
    if (category) {
      setName(category.name);
      setSlug(category.slug);
      setSlugEdited(true); // don't auto-overwrite the slug in edit mode
      setDescription(category.description ?? "");
      setParentId(category.parentId);
      setIsActive(category.isActive);
    } else {
      setName("");
      setSlug("");
      setSlugEdited(false);
      setDescription("");
      setParentId(defaultParentId ?? null);
      setIsActive(true);
    }
  }, [open, category, defaultParentId]);

  // Auto-generate the slug from the name (unless the admin has manually
  // edited the slug field — then we respect their input).
  function handleNameChange(next: string) {
    setName(next);
    if (!slugEdited) {
      setSlug(autoSlug(next));
    }
  }

  function handleSlugChange(next: string) {
    setSlugEdited(true);
    // Enforce the slug format on input (lowercase, digits, hyphens only).
    setSlug(next.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  }

  // Build a flat, indented list of valid parent options from the tree.
  // In edit mode, exclude the category itself + its descendants (cycle
  // prevention). We do NOT exclude siblings, ancestors, or unrelated
  // branches — only the moved subtree.
  const parentOptions = useMemo(() => {
    const options: { id: number; label: string; depth: number }[] = [];
    const skipPath = category?.path ?? null;

    const walk = (nodes: KbCategoryNode[], depth: number) => {
      for (const node of nodes) {
        // In edit mode, skip the moved node + its descendants.
        if (skipPath && (node.path === skipPath || node.path.startsWith(skipPath))) {
          continue;
        }
        options.push({ id: node.id, label: node.name, depth });
        if (node.children.length > 0) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(tree, 0);
    return options;
  }, [tree, category]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Client-side validation mirrors the backend's rules. The backend
    // also validates, so this is just for fast feedback.
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (trimmedName.length > 100) {
      setError("Name is too long (max 100 characters).");
      return;
    }
    if (!trimmedSlug || !/^[a-z0-9-]+$/.test(trimmedSlug)) {
      setError("Slug must be lowercase letters, digits, and hyphens only.");
      return;
    }
    if (trimmedSlug.startsWith("-") || trimmedSlug.endsWith("-")) {
      setError("Slug cannot start or end with a hyphen.");
      return;
    }
    if (trimmedSlug.length > 80) {
      setError("Slug is too long (max 80 characters).");
      return;
    }
    if (description.length > 500) {
      setError("Description is too long (max 500 characters).");
      return;
    }

    setSaving(true);
    try {
      if (category) {
        // Edit mode — PUT (no parentId change; use Move for that).
        await updateKbCategory(apiFetch, category.id, {
          name: trimmedName,
          slug: trimmedSlug,
          description: description.trim() || null,
          isActive,
        });
      } else {
        // Create mode — POST.
        await createKbCategory(apiFetch, {
          name: trimmedName,
          slug: trimmedSlug,
          description: description.trim() || null,
          parentId,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save category.");
    } finally {
      setSaving(false);
    }
  }

  const isEdit = category !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit KB Category" : "Add KB Category"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Name *
            </Label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              maxLength={100}
              className="mt-1.5 rounded-xl"
              placeholder="e.g. Mango Care"
              autoFocus
            />
          </div>

          {/* Slug */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Slug *
            </Label>
            <Input
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required
              maxLength={80}
              className="mt-1.5 rounded-xl font-mono text-sm"
              placeholder="mango-care"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              Lowercase letters, digits, and hyphens only. Used in URLs + API paths.
            </p>
          </div>

          {/* Parent (create mode only) */}
          {!isEdit && (
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Parent Category
              </Label>
              <Select
                value={parentId === null ? "__root__" : String(parentId)}
                onValueChange={(v) => setParentId(v === "__root__" ? null : Number(v))}
              >
                <SelectTrigger className="mt-1.5 rounded-xl">
                  <SelectValue placeholder="Select a parent (or root)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__root__">— Root (no parent) —</SelectItem>
                  {parentOptions.map((opt) => (
                    <SelectItem key={opt.id} value={String(opt.id)}>
                      {"\u00A0".repeat(opt.depth * 2)}
                      {opt.depth > 0 ? "↳ " : ""}
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground/70 mt-1">
                New categories are created as <span className="font-medium">active</span>. Use
                edit to deactivate later (cascades to descendants).
              </p>
            </div>
          )}

          {/* Description */}
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description (optional)
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1.5 rounded-xl"
              placeholder="Short summary shown in the admin tree + (Phase 2) the AI search tool."
            />
          </div>

          {/* Active toggle (edit mode only) */}
          {isEdit && (
            <div className="flex items-center justify-between rounded-xl border p-3">
              <div>
                <Label className="text-sm font-medium">Active</Label>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Inactive categories are hidden from the AI search tool. Deactivating
                  also deactivates all descendants.
                </p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? "Saving…" : isEdit ? "Update Category" : "Add Category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
