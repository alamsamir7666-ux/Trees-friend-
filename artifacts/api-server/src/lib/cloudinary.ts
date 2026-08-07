import { v2 as cloudinaryV2 } from "cloudinary";
import { logger } from "./logger";

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const cloudinary = cloudinaryV2;

/**
 * Every upload route in this codebase stores only Cloudinary's `secure_url`
 * on our rows (products.images, sellerListings.images, etc.) -- there is no
 * `public_id` column anywhere. That's fine for *displaying* images, but
 * Cloudinary's delete API needs the public_id, not the URL.
 *
 * Rather than migrating every images[] column to store {url, publicId}
 * objects (a breaking change to every upload/read call site), we derive the
 * public_id from the URL at delete time. Cloudinary secure_urls are
 * predictable:
 *
 *   https://res.cloudinary.com/<cloud>/image/upload/v1234567890/folder/name.jpg
 *   https://res.cloudinary.com/<cloud>/image/upload/f_jpg/v123/folder/name.jpg
 *   https://res.cloudinary.com/<cloud>/video/upload/v123/folder/name.mp4
 *   https://res.cloudinary.com/<cloud>/raw/upload/v123/folder/invoice.pdf
 *
 * public_id is everything after the version segment (v\d+) or after
 * "upload/", up to (but not including) the file extension, INCLUDING any
 * folder path and any transformation segments that got baked into a stored
 * URL by mistake are stripped too (defensive -- our uploaders don't do this
 * today, but a malformed/hand-edited URL shouldn't throw).
 */
export function publicIdFromUrl(url: string): { publicId: string; resourceType: "image" | "video" | "raw" } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("res.cloudinary.com") && !u.hostname.endsWith("cloudinary.com")) {
      return null;
    }
    const uploadMatch = u.pathname.match(/\/(image|video|raw)\/upload\/(.+)$/);
    if (!uploadMatch) return null;
    const resourceType = uploadMatch[1] as "image" | "video" | "raw";
    let rest = uploadMatch[2];

    // Strip any transformation/version segments (f_jpg, q_auto, v1234567890,
    // etc.) -- keep only segments from the first real version marker or
    // folder segment onward. Transformation segments always contain "_" or
    // start with "v" + digits; a real folder/public_id segment for this repo
    // never matches /^v\d+$/ and our folders (envyenhance/*, treefriend/*)
    // don't contain underscore-prefixed transformation codes.
    const segments = rest.split("/");
    const versionIdx = segments.findIndex((s) => /^v\d+$/.test(s));
    const startIdx = versionIdx >= 0 ? versionIdx + 1 : 0;
    rest = segments.slice(startIdx).join("/");

    // Drop the file extension (public_id excludes it) -- EXCEPT for "raw"
    // resources, where Cloudinary's public_id includes the extension (raw
    // files are stored/addressed as opaque blobs, unlike image/video which
    // get format-aware derivations). Stripping the extension from a raw
    // public_id would make delete_resources silently miss it. Confirmed
    // against Cloudinary's own docs: for image/video, don't include the
    // extension in public_id; for raw, the extension IS part of public_id.
    const publicId = resourceType === "raw" ? rest : rest.replace(/\.[a-zA-Z0-9]+$/, "");
    if (!publicId) return null;
    return { publicId, resourceType };
  } catch {
    return null;
  }
}

/**
 * Deletes one or more Cloudinary assets given their stored secure_urls.
 * Never throws -- storage cleanup must never be allowed to fail the request
 * that the user is actually waiting on (deleting a product, saving an
 * edit, etc). Failures are logged so they're visible in ops/monitoring
 * instead of silently leaking storage.
 *
 * Safe to call with duplicate/empty/non-Cloudinary URLs -- those are
 * filtered out before any API call is made.
 */
export async function deleteCloudinaryAssets(urls: Array<string | null | undefined>): Promise<void> {
  const parsed = urls
    .filter((u): u is string => !!u)
    .map((u) => ({ url: u, parsed: publicIdFromUrl(u) }))
    .filter((x) => x.parsed !== null);

  if (parsed.length === 0) return;

  const byType = new Map<"image" | "video" | "raw", string[]>();
  for (const { parsed: p } of parsed) {
    if (!p) continue;
    const list = byType.get(p.resourceType) ?? [];
    list.push(p.publicId);
    byType.set(p.resourceType, list);
  }

  await Promise.all(
    Array.from(byType.entries()).map(async ([resourceType, publicIds]) => {
      try {
        // delete_resources handles up to 100 public_ids per call and
        // silently no-ops on ids that don't exist, so it's safe even if
        // the URL parsing above is slightly off for an edge case.
        const result = await cloudinaryV2.api.delete_resources(publicIds, { resource_type: resourceType });
        logger.info({ resourceType, publicIds, result: result.deleted }, "Cloudinary assets deleted");
      } catch (err) {
        logger.error({ err, resourceType, publicIds }, "Cloudinary delete failed -- assets may be orphaned, check dashboard");
      }
    }),
  );
}

/**
 * Given the images[] array as it existed before an update and the images[]
 * array the client is now sending, deletes from Cloudinary whatever URLs
 * were present before but are absent now. Call this AFTER the DB write
 * succeeds, never before -- if the DB write fails we must not have already
 * deleted the images the (failed) update was trying to keep.
 */
export async function cleanupRemovedImages(previousUrls: string[], nextUrls: string[]): Promise<void> {
  const nextSet = new Set(nextUrls);
  const removed = previousUrls.filter((u) => !nextSet.has(u));
  if (removed.length === 0) return;
  await deleteCloudinaryAssets(removed);
}
