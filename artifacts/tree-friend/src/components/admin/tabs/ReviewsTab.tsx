import { useAdminContext } from "@/contexts/AdminContext";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, MessageSquare, Star, Trash2 } from "lucide-react";

export function ReviewsTab() {
const {
    reviews,
    reviewsLoading,
    reviewSearch,
    setReviewSearch,
    filteredReviews,
    handleDeleteReview,
  } = useAdminContext();

return (
  <div>
    <div className="mb-4 space-y-3">
      <p className="text-sm text-muted-foreground">All customer reviews across every product. Delete any inappropriate or fake review.</p>
      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by product, customer, or review text..."
          className="pl-10"
          value={reviewSearch}
          onChange={e => setReviewSearch(e.target.value)}
        />
      </div>
    </div>
    {reviewsLoading ? (
      <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
    ) : filteredReviews.length === 0 ? (
      <div className="bg-card rounded-2xl border p-12 text-center">
        <MessageSquare className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <p className="font-semibold text-muted-foreground mb-1">{reviewSearch ? "No reviews match your search." : "No reviews yet"}</p>
        {!reviewSearch && <p className="text-sm text-muted-foreground/70">Customer reviews will appear here once they start rolling in.</p>}
      </div>
    ) : (
      <div className="bg-card rounded-2xl border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Product</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Rating</th>
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Review</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</th>
                <th className="px-5 py-3.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-muted/50">
              {filteredReviews.map((r) => (
                <tr key={r.id} className="hover:bg-primary/5 transition-colors align-top">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      {r.productImage ? (
                        <img src={r.productImage} alt="" className="h-10 w-10 rounded-xl object-cover border shrink-0" />
                      ) : (
                        <div className="h-10 w-10 rounded-xl bg-muted border shrink-0" />
                      )}
                      <div>
                        <p className="font-medium text-foreground text-xs leading-tight">{r.productName}</p>
                        <p className="text-xs text-muted-foreground/70">ID #{r.productId}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-full bg-gradient-to-br from-primary/30 to-primary/50 flex items-center justify-center shrink-0">
                        <span className="text-xs font-bold text-primary-foreground">{r.userName?.[0] ?? "📱"}</span>
                      </div>
                      <p className="text-xs font-medium text-foreground">{r.userName}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={`h-3.5 w-3.5 ${i < r.rating ? "fill-warning-foreground text-warning-foreground" : "text-muted-foreground/30"}`} />
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">{r.rating}/5</p>
                  </td>
                  <td className="px-5 py-4 max-w-[260px]">
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{r.comment}</p>
                  </td>
                  <td className="px-5 py-4 text-right text-xs text-muted-foreground/70 whitespace-nowrap">
                    {new Date(r.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      onClick={() => handleDeleteReview(r.productId, r.id)}
                      className="p-1.5 rounded-lg text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Delete review"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
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
