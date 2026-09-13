/**
 * Cloudinary URL transformation utilities.
 *
 * Cloudinary serves images from `res.cloudinary.com/<cloud-name>/image/upload/...`.
 * Inserting a transformation segment (e.g. `w_400,h_400,c_fill,f_webp,q_75`)
 * between `/upload/` and the rest of the path produces a transformed
 * derivative on-the-fly — Cloudinary caches derivatives, so the first
 * request is slow but subsequent requests are CDN-fast.
 *
 * This util centralizes the rewrite so all components use consistent
 * transformation presets. Previously each component inlined its own
 * `img.includes("res.cloudinary.com") ? img.replace("/upload/", ...) : img`
 * which (a) duplicated logic in 3+ files and (b) made it easy for the
 * presets to drift (ProductCard used `q_75`, ProductDetailPage used `q_80`
 * for thumbnails — accidentally, not by design).
 *
 * ─── Industry-standard Cloudinary transformation flags ─────────────────────
 *
 *   w_<N>     width in pixels
 *   h_<N>     height in pixels
 *   c_fill    crop to fill the requested dimensions (may crop edges)
 *   f_webp    output as WebP (smaller than JPEG for the same quality)
 *   q_<N>     quality 1–100 (75–85 is the sweet spot for photos)
 *
 * ─── When to use which preset ───────────────────────────────────────────────
 *
 *   MAIN_PRODUCT_IMAGE — hero image on the product detail page. Larger,
 *     higher quality (q_85) because it's the primary visual.
 *   PRODUCT_GALLERY_THUMBNAIL — small thumbnails under the hero (the
 *     image picker). WebP, q_80 (slightly lower since they're small).
 *   PRODUCT_CARD — used in product grids, "Related Products", "Recently
 *     Viewed" — small thumbnails in cards, WebP, q_75.
 *   HOMEPAGE_PRODUCT_CARD — even smaller, used in dense homepage grids.
 */

const CLOUDINARY_HOST = "res.cloudinary.com";
const CLOUDINARY_UPLOAD_SEGMENT = "/upload/";

/**
 * Apply a Cloudinary transformation segment to a Cloudinary URL.
 *
 * Non-Cloudinary URLs are returned unchanged (e.g. fallback placeholder
 * URLs, future self-hosted images, etc.).
 *
 * @param url - Original image URL (Cloudinary or otherwise).
 * @param transform - Cloudinary transformation string (e.g. "w_400,h_400,c_fill,f_webp,q_75").
 * @returns Transformed URL, or the original URL if not a Cloudinary URL.
 */
export function withCloudinaryTransform(
  url: string | null | undefined,
  transform: string,
): string | null {
  if (!url) return null;
  if (!url.includes(CLOUDINARY_HOST)) return url;
  // Insert the transformation segment after `/upload/`. Cloudinary's URL
  // format is always:
  //   https://res.cloudinary.com/<cloud>/image/upload/<version>/<public_id>
  // or with existing transformations:
  //   https://res.cloudinary.com/<cloud>/image/upload/<existing-transforms>/<version>/<public_id>
  //
  // We replace the FIRST occurrence of `/upload/` with `/upload/<transform>/`
  // which composes correctly with existing transformations (Cloudinary
  // applies them in order).
  return url.replace(
    CLOUDINARY_UPLOAD_SEGMENT,
    `${CLOUDINARY_UPLOAD_SEGMENT}${transform}/`,
  );
}

// ─── Presets ────────────────────────────────────────────────────────────────
// Centralized so quality/size tradeoffs are tuned in one place. Adjust
// here and every consumer picks up the change automatically.

/** Hero image on product detail page. 800×800, JPEG q_85 (best quality). */
export const MAIN_PRODUCT_IMAGE_TRANSFORM = "w_800,h_800,c_fill,q_85";

/** Gallery thumbnails on product detail page. 800×800, WebP q_80. */
export const PRODUCT_GALLERY_THUMBNAIL_TRANSFORM = "w_800,h_800,c_fill,f_webp,q_80";

/** Product card thumbnail (grids, "Related Products"). 400×400, WebP q_75. */
export const PRODUCT_CARD_TRANSFORM = "w_400,h_400,c_fill,f_webp,q_75";

/** Homepage product card thumbnail. 200×200, WebP q_75 (smaller, denser). */
export const HOMEPAGE_PRODUCT_CARD_TRANSFORM = "w_200,h_200,c_fill,f_webp,q_75";

/**
 * Convenience: transform a URL for the product detail page hero image.
 * Falls back to the original URL if not Cloudinary.
 */
export function mainProductImage(url: string): string;
export function mainProductImage(url: string | null | undefined): string | null;
export function mainProductImage(url: string | null | undefined): string | null {
  return withCloudinaryTransform(url, MAIN_PRODUCT_IMAGE_TRANSFORM);
}

/**
 * Convenience: transform a URL for a product detail page gallery thumbnail.
 */
export function productGalleryThumbnail(url: string): string;
export function productGalleryThumbnail(url: string | null | undefined): string | null;
export function productGalleryThumbnail(url: string | null | undefined): string | null {
  return withCloudinaryTransform(url, PRODUCT_GALLERY_THUMBNAIL_TRANSFORM);
}

/**
 * Convenience: transform a URL for a product card thumbnail (grids).
 */
export function productCardImage(url: string): string;
export function productCardImage(url: string | null | undefined): string | null;
export function productCardImage(url: string | null | undefined): string | null {
  return withCloudinaryTransform(url, PRODUCT_CARD_TRANSFORM);
}

/**
 * Convenience: transform a URL for a homepage product card thumbnail.
 */
export function homepageProductCardImage(url: string): string;
export function homepageProductCardImage(url: string | null | undefined): string | null;
export function homepageProductCardImage(url: string | null | undefined): string | null {
  return withCloudinaryTransform(url, HOMEPAGE_PRODUCT_CARD_TRANSFORM);
}
