import { useState, useEffect, useRef, useMemo } from "react";
import { useApiFetch } from "@/lib/useApiFetch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Search, Save, Pencil, Trash2, X } from "lucide-react";
import { RichTextEditor } from "@/components/admin/RichTextEditor";
import { ProductPicker } from "@/components/admin/ProductPicker";
import { formatReadTime, parseReadTimeInput } from "@/lib/blog";
import { normalizeSlug as normalizeSlugUtil } from "@/lib/slugs";

export function BlogTab() {
  const apiFetch = useApiFetch();
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingPost, setEditingPost] = useState<any | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // readTime is an integer (minutes) in the DB and API. The admin form
  // captures it as a numeric input — not free text — so ranges like
  // "10-15 minutes" can no longer be silently corrupted into 1015 by the
  // backend's old `replace(/\D/g, "")` strip.
  const emptyForm = { slug: "", title: "", excerpt: "", content: "", category: "Plant Care Tips", readTime: 5, image: "", featured: false, slugEdited: false, linkedProductIds: [] as number[] };
  const [form, setForm] = useState(emptyForm);

  const fetchedRef = useRef(false);
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    apiFetch("/api/blog-posts")
      .then(r => r.json())
      .then(data => setPosts(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function openCreate() {
    setEditingPost(null);
    setForm({ ...emptyForm, slugEdited: false });
    setShowForm(true);
    setError("");
  }

  function openEdit(post: any) {
    setEditingPost(post);
    setForm({
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      content: Array.isArray(post.content)
        ? post.content.map((b: any) => {
            if (b.type === "h2") return `<h2>${b.text}</h2>`;
            if (b.type === "h3") return `<h3>${b.text}</h3>`;
            if (b.type === "ul") return `<ul>${(b.items || []).map((i: string) => `<li>${i}</li>`).join("")}</ul>`;
            if (b.type === "tip") return `<blockquote>${b.text}</blockquote>`;
            return `<p>${b.text || ""}</p>`;
          }).join("")
        : (post.content || ""),
      category: post.category,
      readTime: typeof post.readTime === "number" ? post.readTime : parseReadTimeInput(post.readTime),
      image: post.image,
      featured: post.featured,
      slugEdited: true,
      linkedProductIds: Array.isArray(post.linkedProductIds) ? post.linkedProductIds : [],
    });
    setShowForm(true);
    setError("");
  }

  async function handleSave() {
    setSaving(true); setError("");
    try {
      // Normalize readTime to a clamped integer before sending — the backend
      // also does this (defense in depth), but doing it here means the form
      // state is always a clean number, not a string the backend has to guess
      // about.
      const body = { ...form, readTime: parseReadTimeInput(form.readTime), content: form.content };
      const url = editingPost ? `/api/admin/blog-posts/${editingPost.id}` : "/api/admin/blog-posts";
      const method = editingPost ? "PATCH" : "POST";
      const r = await apiFetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error ?? "Failed to save post"); return; }
      if (editingPost) {
        setPosts(prev => prev.map(p => p.id === editingPost.id ? data : p));
      } else {
        setPosts(prev => [data, ...prev]);
      }
      setShowForm(false);
      setEditingPost(null);
    } finally { setSaving(false); }
  }

  async function handleDelete(id: number) {
    const r = await apiFetch(`/api/admin/blog-posts/${id}`, { method: "DELETE" });
    if (r.ok) { setPosts(prev => prev.filter(p => p.id !== id)); setDeleteConfirm(null); }
  }

  // Replaced the local `autoSlug` function with the shared `normalizeSlug`
  // util from `@/lib/slugs` (mirrors the backend's `@workspace/db/logic`
  // implementation). The previous inline regex
  //   title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  // was correct but duplicated the backend's logic — keeping them in sync
  // manually was fragile. Now both layers import the same algorithm.
  const autoSlug = (title: string) => normalizeSlugUtil(title);

  const filtered = useMemo(() =>
    posts.filter(p =>
      !searchQ ||
      p.title.toLowerCase().includes(searchQ.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQ.toLowerCase()) ||
      p.excerpt.toLowerCase().includes(searchQ.toLowerCase())
    ), [posts, searchQ]);

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />)}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Blog Posts</h2>
        <button onClick={openCreate}
          className="flex items-center gap-1.5 text-sm bg-accent text-accent-foreground px-4 py-2 rounded-full hover:bg-accent/90 transition-colors">
          <Plus className="h-4 w-4" />New Post
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search posts by title, category, or excerpt..."
          className="pl-10"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
        />
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
            <div>
              <h3 className="font-semibold text-base">{editingPost ? "Edit Blog Post" : "New Blog Post"}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{editingPost ? "Update your article details below" : "Fill in the details to publish a new article"}</p>
            </div>
            <button onClick={() => { setShowForm(false); setEditingPost(null); }}
              className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title *</Label>
                <Input placeholder="e.g. Best Fruit Trees to Plant in 2025" value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value, slug: f.slugEdited ? f.slug : autoSlug(e.target.value) }))}
                  className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Slug (URL) *</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">/blog/</span>
                  <Input placeholder="best-fruit-trees-to-plant" value={form.slug}
                    onChange={e => setForm(f => ({ ...f, slug: e.target.value, slugEdited: true }))}
                    className="rounded-xl pl-12 font-mono text-sm" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</Label>
                <Input placeholder="e.g. Plant Care Tips" value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="rounded-xl" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Read Time (minutes)</Label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={600}
                    step={1}
                    placeholder="5"
                    value={form.readTime}
                    onChange={e => setForm(f => ({ ...f, readTime: parseReadTimeInput(e.target.value) }))}
                    className="rounded-xl w-28"
                  />
                  {/* Live preview so the admin sees exactly how the read time
                      will render on the public blog page (e.g. "5 min read"). */}
                  <span className="text-xs text-muted-foreground">
                    Displays as: <span className="font-medium text-foreground">{formatReadTime(parseReadTimeInput(form.readTime))}</span>
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cover Image</Label>
              <div className="flex gap-2">
                <Input placeholder="https://..." value={form.image}
                  onChange={e => setForm(f => ({ ...f, image: e.target.value }))}
                  className="rounded-xl flex-1" />
                <button type="button"
                  onClick={() => document.getElementById("blog-image-upload")?.click()}
                  className="shrink-0 text-xs font-medium bg-muted hover:bg-muted/80 px-4 py-2 rounded-xl border transition-colors">
                  Upload
                </button>
                <input type="file" accept="image/*" id="blog-image-upload" className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]; if (!file) return;
                    const fd = new FormData();
                    fd.append("images", file);
                    fd.append("productName", "blog-cover");
                    fd.append("startIndex", "1");
                    const res = await apiFetch("/api/products/upload-image", { method: "POST", body: fd });
                    const data = await res.json();
                    if (data.urls?.[0]) setForm(f => ({ ...f, image: data.urls[0] }));
                    e.target.value = "";
                  }} />
              </div>
              {form.image && (
                <div className="relative mt-2 w-full h-40 rounded-xl overflow-hidden border">
                  <img src={form.image} alt="preview" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => setForm(f => ({ ...f, image: "" }))}
                    className="absolute top-2 right-2 bg-foreground/60 hover:bg-foreground/80 text-background rounded-full w-7 h-7 flex items-center justify-center transition-colors">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Excerpt *</Label>
              <Textarea placeholder="A short description shown in the blog listing (1-2 sentences)"
                value={form.excerpt} rows={2}
                onChange={e => setForm(f => ({ ...f, excerpt: e.target.value }))}
                className="rounded-xl resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Content *</Label>
              <RichTextEditor
                value={form.content}
                onChange={html => setForm(f => ({ ...f, content: html }))}
                placeholder="Write your article content here..."
                minHeight={280}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked Products</Label>
              <p className="text-xs text-muted-foreground -mt-1">Shown as swipeable cards at the end of the post. Max 3.</p>
              <ProductPicker
                selectedIds={form.linkedProductIds}
                onChange={ids => setForm(f => ({ ...f, linkedProductIds: ids }))}
                max={3}
              />
            </div>
            <div className="flex items-center gap-3 p-4 bg-muted/30 rounded-xl border">
              <input type="checkbox" id="featured" checked={form.featured}
                onChange={e => setForm(f => ({ ...f, featured: e.target.checked }))}
                className="w-4 h-4 accent-accent cursor-pointer" />
              <div>
                <Label htmlFor="featured" className="text-sm font-medium cursor-pointer">Featured post</Label>
                <p className="text-xs text-muted-foreground">Featured posts appear prominently at the top of the blog page</p>
              </div>
            </div>
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-4 py-3 rounded-xl">
                <X className="h-4 w-4 shrink-0" />{error}
              </div>
            )}
            <div className="flex gap-3 pt-1">
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 text-sm font-semibold bg-accent text-accent-foreground px-5 py-2.5 rounded-xl hover:bg-accent/90 transition-colors disabled:opacity-50">
                <Save className="h-4 w-4" />{saving ? "Saving..." : editingPost ? "Save Changes" : "Publish Post"}
              </button>
              <button onClick={() => { setShowForm(false); setEditingPost(null); }}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-4 py-2.5 rounded-xl hover:bg-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {searchQ ? "No posts match your search." : "No blog posts yet. Create your first post!"}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map(post => (
            <div key={post.id} className="flex items-start gap-4 bg-card border rounded-xl p-4">
              {post.image && (
                <img src={post.image} alt={post.title}
                  className="w-16 h-16 object-cover rounded-lg shrink-0" loading="lazy" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full">{post.category}</span>
                  {post.featured && <span className="text-xs bg-warning text-warning-foreground px-2 py-0.5 rounded-full">Featured</span>}
                  <span className="text-xs text-muted-foreground">{formatReadTime(post.readTime)}</span>
                </div>
                <h3 className="font-medium text-sm line-clamp-1">{post.title}</h3>
                <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{post.excerpt}</p>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">/blog/{post.slug}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => openEdit(post)} title="Edit"
                  className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {deleteConfirm === post.id ? (
                  <div className="flex gap-1 items-center">
                    <button onClick={() => handleDelete(post.id)}
                      className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20">Delete</button>
                    <button onClick={() => setDeleteConfirm(null)}
                      className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80">No</button>
                  </div>
                ) : (
                  <button onClick={() => setDeleteConfirm(post.id)} title="Delete"
                    className="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Audit Logs Tab ──────────────────────────────────────────────────────
