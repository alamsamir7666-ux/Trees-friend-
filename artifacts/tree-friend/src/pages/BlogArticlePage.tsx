import { useParams, Link } from "wouter";
import { ArrowLeft, Clock, Tag, Share2, Check, BookOpen, FileText } from "lucide-react";
import { useState, useEffect } from "react";
import { apiClient } from "@/lib/apiClient";
import { updateSEO } from "@/lib/seo";
import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { BlogProductCarousel } from "@/components/blog/BlogProductCarousel";

export function BlogArticlePage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug ?? "";
  const [copied, setCopied] = useState(false);
  const [article, setArticle] = useState<any | null>(undefined as any);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) { setLoading(false); return; }
    // Fetch from API
    apiClient.get(`/api/blog-posts/${slug}`)
      .then(({ data }) => {
        const r = data as any;
        return r;
      })
      .then(data => {
        // Normalise API response to match static article shape
        setArticle({
          title: data.title,
          excerpt: data.excerpt,
          category: data.category,
          readTime: data.readTime,
          date: data.publishedAt,
          image: data.image,
          content: Array.isArray(data.content) ? data.content : (data.content || ""),
          linkedProducts: Array.isArray(data.linkedProducts) ? data.linkedProducts : [],
        });
      })
      .catch(() => {
        setArticle(null);
      })
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-10 max-w-3xl">
        <PageBreadcrumb crumbs={[{ label: "Blog", href: "/blog", icon: <BookOpen className="h-3 w-3" /> }, { label: "Loading..." }]} className="mb-6" />
        <div className="flex justify-center py-24">
          <FileText className="h-8 w-8 animate-pulse text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!article) {
    return (
      <div className="container mx-auto px-4 py-24 max-w-3xl text-center">
        <BookOpen className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <h1 className="font-serif text-2xl font-medium mb-2">Article Not Found</h1>
        <p className="text-muted-foreground mb-6">This article doesn't exist or may have been removed.</p>
        <Link href="/blog">
          <span className="inline-flex items-center gap-1.5 text-accent text-sm font-medium cursor-pointer">
            <ArrowLeft className="h-4 w-4" /> Back to Blog
          </span>
        </Link>
      </div>
    );
  }

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({ title: article.title, url: window.location.href }).catch(() => {});
    } else {
      navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="container mx-auto px-4 py-10 max-w-3xl">
      <PageBreadcrumb
        crumbs={[
          { label: "Blog", href: "/blog", icon: <BookOpen className="h-3 w-3" /> },
          { label: article.title },
        ]}
        className="mb-6"
      />

      <Link href="/blog">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent text-sm mb-6 cursor-pointer">
          <ArrowLeft className="h-4 w-4" /> Back to Blog
        </span>
      </Link>

      <div className="flex items-center gap-3 mb-4">
        <span className="bg-accent/10 text-accent text-xs px-3 py-1 rounded-full flex items-center gap-1">
          <Tag className="h-3 w-3" />{article.category}
        </span>
        <span className="text-muted-foreground text-xs flex items-center gap-1">
          <Clock className="h-3 w-3" />{article.readTime}
        </span>
        <span className="text-muted-foreground text-xs">{article.date}</span>
      </div>

      <h1 className="font-serif text-3xl md:text-4xl font-medium mb-4">{article.title}</h1>
      <p className="text-muted-foreground text-lg mb-8">{article.excerpt}</p>

      {article.image && (
        <img
          src={article.image}
          alt={article.title}
          className="w-full h-72 md:h-96 object-cover rounded-2xl mb-10"
        />
      )}

      <div className="prose prose-sm md:prose-base max-w-none prose-headings:font-serif">
        {Array.isArray(article.content) ? (
          article.content.map((block: any, i: number) => {
            if (block.type === "h2") return <h2 key={i} className="font-serif text-xl md:text-2xl font-medium mt-8 mb-3">{block.text}</h2>;
            if (block.type === "h3") return <h3 key={i} className="font-serif text-lg font-medium mt-6 mb-2">{block.text}</h3>;
            if (block.type === "p") return <p key={i} className="text-sm md:text-base leading-relaxed mb-4 text-foreground/90">{block.text}</p>;
            if (block.type === "ul") return (
              <ul key={i} className="list-disc pl-5 mb-4 space-y-1.5">
                {block.items?.map((item: string, j: number) => (
                  <li key={j} className="text-sm md:text-base text-foreground/90">{item}</li>
                ))}
              </ul>
            );
            if (block.type === "tip") return (
              <div key={i} className="bg-accent/5 border border-accent/20 rounded-xl p-4 my-6 text-sm">
                {block.text}
              </div>
            );
            return null;
          })
        ) : (
          <div dangerouslySetInnerHTML={{ __html: article.content || "" }} />
        )}
      </div>

      <BlogProductCarousel products={article.linkedProducts || []} />

      <div className="flex items-center justify-between mt-12 pt-6 border-t">
        <Link href="/blog">
          <span className="inline-flex items-center gap-1.5 text-accent text-sm font-medium cursor-pointer">
            <ArrowLeft className="h-4 w-4" /> More Articles
          </span>
        </Link>
        <button
          onClick={handleShare}
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-accent text-sm transition-colors"
        >
          {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
          {copied ? "Copied!" : "Share"}
        </button>
      </div>
    </div>
  );
}
