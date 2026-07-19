import { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Search, Save, Pencil, Trash2, X } from "lucide-react";
import { RichTextEditor } from "@/components/admin/RichTextEditor";
import { ProductPicker } from "@/components/admin/ProductPicker";

const API = import.meta.env.VITE_API_BASE_URL ?? "";

export function BlogTab() {
  const { getToken } = useAuth();
  console.log("[BlogTab] component function called/rendered");
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingPost, setEditingPost] = useState<any | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const emptyForm = { slug: "", title: "", excerpt: "", content: "", category: "Plant Care Tips", readTime: "5 min read", image: "", featured: false, slugEdited: false, linkedProductIds: [] as number[] };
  const [form, setForm] = useState(emptyForm);

  const fetchedRef = useRef(false);
  useEffect(() => {
    console.log("[BlogTab] MOUNT EFFECT FIRED - fetchedRef was:", fetchedRef.current);
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    getToken().then(token => fetch(API+"/api/blog-posts", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setPosts(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false)));
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
      readTime: post.readTime,
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
      const body = { ...form, content: form.content };
      const url = editingPost ? `${API}/api/admin/blog-posts/${editingPost.id}` : API+"/api/admin/blog-posts";
      const method = editingPost ? "PATCH" : "POST";
      const r = await fetch(url, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
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
    const r = await fetch(`${API}/api/admin/blog-posts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${await getToken()}` } });
    if (r.ok) { setPosts(prev => prev.filter(p => p.id !== id)); setDeleteConfirm(null); }
  }

  function autoSlug(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

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
          className="flex items-center gap-1.5 text-sm bg-accent text-white px-4 py-2 rounded-full hover:bg-accent/90 transition-colors">
          <Plus className="h-4 w-4" />New Post
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search posts by title, category, or excerpt?"
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
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Read Time</Label>
                <Input placeholder="e.g. 5 min read" value={form.readTime}
                  onChange={e => setForm(f => ({ ...f, readTime: e.target.value }))}
                  className="rounded-xl" />
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
                    const token = await getToken();
                    const res = await fetch(`${API}/api/products/upload-image`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
                    const data = await res.json();
                    if (data.urls?.[0]) setForm(f => ({ ...f, image: data.urls[0] }));
                    e.target.value = "";
                  }} />
              </div>
              {form.image && (
                <div className="relative mt-2 w-full h-40 rounded-xl overflow-hidden border">
                  <img src={form.image} alt="preview" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => setForm(f => ({ ...f, image: "" }))}
                    className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors">
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
                className="flex items-center gap-2 text-sm font-semibold bg-accent text-white px-5 py-2.5 rounded-xl hover:bg-accent/90 transition-colors disabled:opacity-50">
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
                  {post.featured && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Featured</span>}
                  <span className="text-xs text-muted-foreground">{post.readTime}</span>
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
                      className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">Delete</button>
                    <button onClick={() => setDeleteConfirm(null)}
                      className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80">No</button>
                  </div>
                ) : (
                  <button onClick={() => setDeleteConfirm(post.id)} title="Delete"
                    className="p-1.5 rounded hover:bg-red-50 transition-colors text-muted-foreground hover:text-red-600">
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

// ??? Audit Logs Tab ???????????????????????????????????????????????????????????
