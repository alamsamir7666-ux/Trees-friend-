// artifacts/tree-friend/src/components/ui/PhotoReviewForm.tsx
// Drop this into ProductDetailPage.tsx replacing the existing review form section.
// Supports up to 4 photo uploads via Cloudinary (through your backend).
import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Star, ImagePlus, X, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PhotoReviewFormProps {
  productId: number;
  onSuccess: () => void;
  onCancel: () => void;
}

export function PhotoReviewForm({ productId, onSuccess, onCancel }: PhotoReviewFormProps) {
  const { toast } = useToast();
  const [rating, setRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handlePhotoAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const remaining = 4 - photos.length;
    const newFiles = files.slice(0, remaining);
    setPhotos((prev) => [...prev, ...newFiles]);
    setPreviews((prev) => [
      ...prev,
      ...newFiles.map((f) => URL.createObjectURL(f)),
    ]);
    // Reset input so same file can be re-added after removal
    e.target.value = "";
  }

  function removePhoto(i: number) {
    URL.revokeObjectURL(previews[i]);
    setPhotos((prev) => prev.filter((_, idx) => idx !== i));
    setPreviews((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSubmit() {
    if (comment.trim().length < 5) {
      toast({ title: "Comment must be at least 5 characters", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("rating", String(rating));
      formData.append("comment", comment.trim());
      photos.forEach((f) => formData.append("photos", f));

      const r = await fetch(`/api/reviews/${productId}`, {
        method: "POST",
        credentials: "include",
        body: formData,
        // Do NOT set Content-Type - browser sets multipart boundary automatically
      });

      const data = await r.json();
      if (!r.ok) {
        toast({ title: data.error ?? "Failed to submit review", variant: "destructive" });
        return;
      }
      toast({ title: "Review submitted! Thank you." });
      onSuccess();
    } catch {
      toast({ title: "Something went wrong. Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-muted/30 rounded-2xl p-6 mb-8 space-y-5">
      <h3 className="font-medium">Your Review</h3>

      {/* Star rating */}
      <div>
        <p className="text-sm text-muted-foreground mb-2">Rating</p>
        <div className="flex gap-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <button
              key={i}
              onMouseEnter={() => setHoverRating(i + 1)}
              onMouseLeave={() => setHoverRating(0)}
              onClick={() => setRating(i + 1)}
              type="button"
            >
              <Star
                className={`h-7 w-7 transition-colors ${
                  i < (hoverRating || rating)
                    ? "fill-accent text-accent"
                    : "text-muted-foreground"
                }`}
              />
            </button>
          ))}
          <span className="text-sm text-muted-foreground self-center ml-2">
            {["", "Poor", "Fair", "Good", "Very Good", "Excellent"][hoverRating || rating]}
          </span>
        </div>
      </div>

      {/* Comment */}
      <div>
        <label className="text-sm text-muted-foreground mb-2 block">
          Your Experience
          <span className="ml-1 text-xs">({comment.trim().length}/1000)</span>
        </label>
        <Textarea
          placeholder="Share your honest experience with this product?"
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 1000))}
          rows={4}
        />
      </div>

      {/* Photo uploads */}
      <div>
        <p className="text-sm text-muted-foreground mb-2">
          Photos <span className="text-xs">(optional, up to 4)</span>
        </p>
        <div className="flex flex-wrap gap-3">
          {previews.map((src, i) => (
            <div key={i} className="relative h-20 w-20 rounded-xl overflow-hidden bg-muted border">
              <img src={src} alt={`Preview ${i + 1}`} className="h-full w-full object-cover" />
              <button
                onClick={() => removePhoto(i)}
                className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 flex items-center justify-center"
                type="button"
              >
                <X className="h-3 w-3 text-white" />
              </button>
            </div>
          ))}
          {photos.length < 4 && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="h-20 w-20 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-accent hover:text-accent transition-colors"
            >
              <ImagePlus className="h-5 w-5" />
              <span className="text-xs">Add</span>
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePhotoAdd}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        <Button
          onClick={handleSubmit}
          disabled={submitting || comment.trim().length < 5}
          className="flex-1"
        >
          {submitting ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Submitting?</>
          ) : (
            "Submit Review"
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
