import { useState, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/apiClient";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────
interface HomepageSection {
  id: number;
  key: string;
  label: string;
  displayOrder: number;
}

// ─── Sortable Row ─────────────────────────────────────────────────────────────
function SortableRow({
  section,
  onDelete,
  deleting,
}: {
  section: HomepageSection;
  onDelete: (id: number) => void;
  deleting: number | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-background border border-border rounded-xl px-4 py-3 group"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Label */}
      <span className="flex-1 text-sm font-medium">{section.label}</span>

      {/* Key badge */}
      <span className="text-xs text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded-md hidden sm:block">
        {section.key}
      </span>

      {/* Delete */}
      <button
        onClick={() => onDelete(section.id)}
        disabled={deleting === section.id}
        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
        aria-label="Delete section"
      >
        {deleting === section.id ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────
export function HomepageSectionsTab() {
  const [sections, setSections] = useState<HomepageSection[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding]     = useState(false);
  const [showInput, setShowInput] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // ── Fetch ────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    apiClient
      .get<HomepageSection[]>("/api/homepage-sections")
      .then(({ data }) => setSections(data))
      .catch(() => toast.error("Failed to load homepage sections"))
      .finally(() => setLoading(false));
  }, []);

  // ── Drag end ─────────────────────────────────────────────────────────────
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sections.findIndex(s => s.id === active.id);
    const newIndex = sections.findIndex(s => s.id === over.id);
    const reordered = arrayMove(sections, oldIndex, newIndex);
    setSections(reordered); // optimistic

    setSaving(true);
    try {
      await apiClient.patch("/api/homepage-sections/reorder", {
        ids: reordered.map((s: HomepageSection) => s.id),
      });
      toast.success("Order saved");
    } catch {
      toast.error("Failed to save order");
      // revert
      setSections(sections);
    } finally {
      setSaving(false);
    }
  }

  // ── Add section ──────────────────────────────────────────────────────────
  async function handleAdd() {
    if (!newLabel.trim()) return;
    setAdding(true);
    try {
      const { data } = await apiClient.post<HomepageSection>("/api/homepage-sections", {
        label: newLabel.trim(),
      });
      setSections(prev => [...prev, data]);
      setNewLabel("");
      setShowInput(false);
      toast.success(`"${data.label}" section created`);
    } catch {
      toast.error("Failed to create section");
    } finally {
      setAdding(false);
    }
  }

  // ── Delete section ───────────────────────────────────────────────────────
  async function handleDelete(id: number) {
    const section = sections.find(s => s.id === id);
    if (!confirm(`Delete "${section?.label}"? Products tagged with this section will show "Not on homepage".`)) return;
    setDeleting(id);
    try {
      await apiClient.delete(`/api/homepage-sections/${id}`);
      setSections(prev => prev.filter(s => s.id !== id));
      toast.success("Section deleted");
    } catch {
      toast.error("Failed to delete section");
    } finally {
      setDeleting(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-xl font-semibold">Homepage Sections</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage the tabs shown in the "Best Plants &amp; Trees" section. Drag to reorder.
          </p>
        </div>
        {saving && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </span>
        )}
      </div>

      <div className="mt-6 space-y-2">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded-xl bg-muted animate-pulse" />
          ))
        ) : sections.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            No sections yet. Add your first one below.
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
              {sections.map(section => (
                <SortableRow
                  key={section.id}
                  section={section}
                  onDelete={handleDelete}
                  deleting={deleting}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Add section */}
      <div className="mt-4">
        {showInput ? (
          <div className="flex gap-2 items-center">
            <Input
              autoFocus
              placeholder="e.g. Fruit Trees"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") { setShowInput(false); setNewLabel(""); } }}
              className="rounded-xl"
            />
            <Button onClick={handleAdd} disabled={adding || !newLabel.trim()} className="rounded-xl shrink-0">
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
            <Button variant="ghost" onClick={() => { setShowInput(false); setNewLabel(""); }} className="rounded-xl shrink-0">
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full rounded-xl border-dashed gap-2"
            onClick={() => setShowInput(true)}
          >
            <Plus className="h-4 w-4" /> Add Section
          </Button>
        )}
      </div>

      {/* Key info */}
      {sections.length > 0 && (
        <p className="mt-6 text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium">Tip:</span> The key shown in grey is the tag used on products. When you assign a product to a section in the product editor, it uses this key.
        </p>
      )}
    </div>
  );
}
