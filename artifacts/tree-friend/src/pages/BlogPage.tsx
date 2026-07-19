import { useState, useEffect } from "react";
import { apiClient } from "@/lib/apiClient";
import { updateSEO } from "@/lib/seo";
import { Link } from "wouter";
import { ArrowRight, Clock, Tag, BookOpen, Loader2 } from "lucide-react";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";

updateSEO({
  title: "Plant Care Tips & Guides",
  description: "Expert plant care tips, tree-growing guides, and gardening advice for Bangladesh.",
});

interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  readTime: string;
  publishedAt: string;
  featured: boolean;
  image: string;
}

export function BlogPage() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get("/api/blog-posts")
      .then(({ data }) => {
        setPosts(Array.isArray(data) ? data as BlogPost[] : []);
      })
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  }, []);

  const featured = posts.find(p => p.featured) ?? posts[0];
  const rest = posts.filter(p => p !== featured);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-10 max-w-5xl">
        <PageBreadcrumb crumbs={[{ label: "Blog", icon: <BookOpen className="h-3 w-3" /> }]} className="mb-6" />
        <div className="flex justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 max-w-5xl">
      <PageBreadcrumb crumbs={[{ label: "Blog", icon: <BookOpen className="h-3 w-3" /> }]} className="mb-6" />
      <div className="mb-10 text-center">
        <p className="text-xs uppercase tracking-widest text-accent mb-2">Knowledge Base</p>
        <h1 className="font-serif text-3xl md:text-4xl font-medium">Plant Care Tips & Guides</h1>
        <p className="text-muted-foreground mt-3 max-w-lg mx-auto">
          Expert advice on tree and plant care, growing routines, and everything in between - written for the Bangladesh climate.
        </p>
      </div>

      {/* Featured post */}
      {featured && (
        <Link href={`/blog/${featured.slug}`}>
          <div className="group relative rounded-3xl overflow-hidden mb-10 cursor-pointer">
            {featured.image && (
              <img
                src={featured.image}
                alt={featured.title}
                className="w-full h-72 md:h-96 object-cover transition-transform duration-500 group-hover:scale-105"
                loading="eager"
              />
            )}
            {!featured.image && (
              <div className="w-full h-72 md:h-96 bg-muted flex items-center justify-center">
                <BookOpen className="h-16 w-16 text-muted-foreground/30" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
            <div className="absolute bottom-0 left-0 p-6 md:p-8 text-white">
              <div className="flex items-center gap-3 mb-3">
                <span className="bg-accent text-white text-xs px-3 py-1 rounded-full">{featured.category}</span>
                <span className="text-white/70 text-xs flex items-center gap-1"><Clock className="h-3 w-3" />{featured.readTime}</span>
              </div>
              <h2 className="font-serif text-xl md:text-2xl font-medium mb-2">{featured.title}</h2>
              <p className="text-white/80 text-sm line-clamp-2 max-w-xl">{featured.excerpt}</p>
              <div className="mt-4 flex items-center gap-1.5 text-accent text-sm font-medium">
                Read Article <ArrowRight className="h-4 w-4" />
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Grid */}
      {rest.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {rest.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`}>
              <article className="group bg-card border rounded-2xl overflow-hidden hover:shadow-lg transition-all duration-300 hover:-translate-y-0.5 cursor-pointer h-full flex flex-col">
                {post.image ? (
                  <div className="aspect-[16/10] overflow-hidden">
                    <img
                      src={post.image}
                      alt={post.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      loading="lazy"
                    />
                  </div>
                ) : (
                  <div className="aspect-[16/10] bg-muted flex items-center justify-center">
                    <BookOpen className="h-10 w-10 text-muted-foreground/30" />
                  </div>
                )}
                <div className="p-5 flex-1 flex flex-col">
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="text-xs text-accent flex items-center gap-1">
                      <Tag className="h-3 w-3" />{post.category}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />{post.readTime}
                    </span>
                  </div>
                  <h3 className="font-semibold text-sm leading-snug mb-2 flex-1">{post.title}</h3>
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-4">{post.excerpt}</p>
                  <div className="flex items-center gap-1 text-xs text-accent font-medium">
                    Read Article <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </div>
              </article>
            </Link>
          ))}
        </div>
      )}

      {posts.length === 0 && !loading && (
        <div className="py-24 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-muted-foreground">No blog posts yet. Check back soon!</p>
        </div>
      )}
    </div>
  );
}
