import { useState } from "react";
import { Link } from "wouter";
import {
  useListSellerListingReviews, useCreateSellerListingReview, useGetSellerListingReviewEligibility,
  useUpdateReview, useDeleteReview,
  getListSellerListingReviewsQueryKey, getGetSellerListingReviewEligibilityQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Star, Check, Lock, Pencil, Trash2 } from "lucide-react";

/**
 * Reviews for a specific seller's listing -- fully separate from the
 * product-level reviews on ProductDetailPage.tsx (per product decision).
 *
 * Reviews attach to the exact VARIANT a buyer purchased, not just the
 * listing (reviewsTable's own schema doc comment, Phase 2, and product
 * decision: a Sapling and a Grafted tree from the same seller are
 * different purchase experiences). So eligibility and creation are keyed
 * on sellerListingVariantId (the CURRENTLY SELECTED variant on the page,
 * passed in as a prop) -- a buyer who bought Sapling can't review under
 * Grafted just because they're both this listing.
 *
 * The DISPLAY list below still shows every review for the whole listing
 * together (matches sellerListingId-grouped rating aggregation elsewhere,
 * e.g. the star rating on the listing card) rather than filtering to only
 * the selected variant's reviews -- each review is labeled with which
 * variant it's for when that's known, so a reader can judge relevance.
 *
 * Edit/delete reuse the same PUT /reviews/:reviewId and
 * DELETE /reviews/:productId/:reviewId endpoints product reviews use --
 * those operate on the review row by id/ownership and don't care which
 * kind of review it is, so no separate edit/delete endpoints were needed.
 */
export function SellerListingReviews({
  sellerListingId,
  sellerListingVariantId,
  variantLabel,
  productId,
}: {
  sellerListingId: number;
  sellerListingVariantId: number;
  variantLabel: string;
  productId: number;
}) {
  const { user } = useUser();
  const qc = useQueryClient();

  const { data: reviews } = useListSellerListingReviews(sellerListingId, {
    query: { enabled: !!sellerListingId, queryKey: getListSellerListingReviewsQueryKey(sellerListingId) },
  });
  const { data: eligibility } = useGetSellerListingReviewEligibility(sellerListingId, sellerListingVariantId, {
    query: {
      enabled: !!user && !!sellerListingId && !!sellerListingVariantId,
      retry: false,
      queryKey: getGetSellerListingReviewEligibilityQueryKey(sellerListingId, sellerListingVariantId),
    },
  });

  const createReview = useCreateSellerListingReview();
  const updateReview = useUpdateReview();
  const deleteReview = useDeleteReview();

  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [editingReviewId, setEditingReviewId] = useState<number | null>(null);
  const [editRating, setEditRating] = useState(5);
  const [editComment, setEditComment] = useState("");

  const canReview = eligibility?.canReview ?? false;
  const alreadyReviewed = eligibility?.reason === "already_reviewed";
  const notPurchased = !user || eligibility?.reason === "not_purchased";

  function handleReview() {
    if (!user) return;
    createReview.mutate({ sellerListingId, data: { sellerListingVariantId, rating, comment } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSellerListingReviewsQueryKey(sellerListingId) });
        qc.invalidateQueries({ queryKey: getGetSellerListingReviewEligibilityQueryKey(sellerListingId, sellerListingVariantId) });
        setComment(""); setRating(5); setShowReviewForm(false);
      },
    });
  }

  function startEditReview(r: { id: number; rating: number; comment: string }) {
    setEditingReviewId(r.id);
    setEditRating(r.rating);
    setEditComment(r.comment);
  }

  function handleUpdateReview() {
    if (editingReviewId == null) return;
    updateReview.mutate({ reviewId: editingReviewId, data: { rating: editRating, comment: editComment } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSellerListingReviewsQueryKey(sellerListingId) });
        setEditingReviewId(null);
      },
    });
  }

  function handleDeleteReview(reviewId: number) {
    if (!confirm("Delete your review?")) return;
    deleteReview.mutate({ productId, reviewId }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSellerListingReviewsQueryKey(sellerListingId) });
        qc.invalidateQueries({ queryKey: getGetSellerListingReviewEligibilityQueryKey(sellerListingId, sellerListingVariantId) });
      },
    });
  }

  return (
    <section className="border-t pt-12 mb-16">
      <div className="flex items-center justify-between mb-8">
        <h2 className="font-serif text-2xl font-medium">Customer Reviews</h2>
        {user && canReview && (
          <Button variant="outline" onClick={() => setShowReviewForm(!showReviewForm)}>
            {showReviewForm ? "Cancel" : `Review "${variantLabel}"`}
          </Button>
        )}
        {user && alreadyReviewed && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
            <Check className="h-3.5 w-3.5 text-green-600" /> You've reviewed this variant
          </span>
        )}
      </div>

      {showReviewForm && canReview && (
        <div className="bg-muted/30 rounded-2xl p-6 mb-8">
          <h3 className="font-medium mb-1">Your Review</h3>
          <p className="text-xs text-muted-foreground mb-4">For the "{variantLabel}" option you purchased</p>
          <div className="flex gap-2 mb-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <button key={i} onClick={() => setRating(i + 1)}>
                <Star className={`h-6 w-6 ${i < rating ? "fill-accent text-accent" : "text-muted-foreground"}`} />
              </button>
            ))}
          </div>
          <Textarea placeholder="Share your experience with this seller's listing..." value={comment} onChange={(e) => setComment(e.target.value)} className="mb-4" rows={4} />
          <Button onClick={handleReview} disabled={createReview.isPending || !comment.trim()}>Submit Review</Button>
        </div>
      )}

      {user && notPurchased && !alreadyReviewed && (
        <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-xl px-5 py-4 mb-8 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/60" />
          <div>
            <p className="font-medium text-foreground mb-0.5">Reviews are for verified purchasers</p>
            <p>You need to buy the "{variantLabel}" option from this seller before you can review it.</p>
            <Link href="/orders"><span className="text-accent underline underline-offset-2 hover:text-accent/80 mt-1 inline-block">View your orders ?</span></Link>
          </div>
        </div>
      )}

      {!user && (
        <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-xl px-5 py-4 mb-8 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/60" />
          <div>
            <p className="font-medium text-foreground mb-0.5">Sign in to leave a review</p>
            <p>Only verified purchasers can review seller listings.</p>
            <Link href="/sign-in"><span className="text-accent underline underline-offset-2 hover:text-accent/80 mt-1 inline-block">Sign in ?</span></Link>
          </div>
        </div>
      )}

      {(reviews ?? []).length === 0 ? (
        <p className="text-muted-foreground text-center py-10">No reviews yet. Be the first to share your experience.</p>
      ) : (
        <div className="space-y-6">
          {(reviews ?? []).map((r) => {
            const isOwner = user?.id === r.userId;
            const isEditing = editingReviewId === r.id;
            const isThisVariant = r.sellerListingVariantId === sellerListingVariantId;
            return (
              <div key={r.id} className="border-b pb-6 last:border-0">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{r.userName}</p>
                      {r.sellerListingVariantId != null && (
                        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${isThisVariant ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground"}`}>
                          {isThisVariant ? variantLabel : "other option"}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star key={i} className={`h-3.5 w-3.5 ${i < r.rating ? "fill-accent text-accent" : "text-muted"}`} />
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</span>
                    {isOwner && !isEditing && (
                      <>
                        <button onClick={() => startEditReview(r)} className="p-1.5 rounded-lg text-muted-foreground hover:text-blue-500 hover:bg-blue-50 transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => handleDeleteReview(r.id)} className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                      </>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <div className="bg-muted/30 rounded-xl p-4 mt-2">
                    <div className="flex gap-1.5 mb-3">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <button key={i} onClick={() => setEditRating(i + 1)}>
                          <Star className={`h-5 w-5 ${i < editRating ? "fill-accent text-accent" : "text-muted-foreground"}`} />
                        </button>
                      ))}
                    </div>
                    <Textarea value={editComment} onChange={(e) => setEditComment(e.target.value)} className="mb-3" rows={3} />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleUpdateReview} disabled={updateReview.isPending || !editComment.trim()}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingReviewId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground leading-relaxed">{r.comment}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
