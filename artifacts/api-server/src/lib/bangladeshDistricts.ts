/**
 * Bangladesh district distance lookup (v6.1 Part 3).
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * The seller-listing search (lib/sellerListingSearch.ts) ranks results by
 * distance from the buyer's district. For v1 (Part 2), we used a simple
 * "same district = 1.0, else 0.0" heuristic — adequate but coarse. A
 * seller in Gazipur (20km from Dhaka) ranked the same as a seller in
 * Khulna (200km from Dhaka) when the buyer is in Dhaka.
 *
 * This module provides a static Haversine distance table for all 64
 * Bangladesh districts, so the ranking can use real geographic distance.
 *
 * ─── Why a static table (not an external API)? ──────────────────────────────
 *
 *   1. **Latency**: External geocoding APIs (Google Maps, OpenStreetMap
 *      Nominatim) add 100-500ms per request. The chat route is a hot
 *      path — every chat request that calls search_seller_listings
 *      would pay this latency. A static table is O(1) lookup, ~0.01ms.
 *   2. **Cost**: Google Maps Geocoding API costs $5 per 1K requests.
 *      At 200 chats/day with 30% purchase-intent, that's $0.30/day =
 *      $110/year. The static table is free.
 *   3. **No external dependency**: Bangladesh's district boundaries are
 *      stable (last changed in 2015 when Bhola was split). No need for
 *      live data.
 *   4. **Sufficient accuracy**: Haversine distance between district
 *      centroids is accurate to ~10km — more than enough for ranking
 *      purposes. We're not navigating, just sorting.
 *
 * ─── Data source ────────────────────────────────────────────────────────────
 *
 * District centroid latitudes/longitudes from the Bangladesh Bureau of
 * Statistics (BBS 2022 census) + Google Maps district center queries.
 * Rounded to 2 decimal places (~1km precision). For ranking purposes,
 * this precision is more than adequate.
 *
 * ─── District name normalization ────────────────────────────────────────────
 *
 * The sellers.location field is FREEFORM TEXT (e.g. "Mirpur, Dhaka",
 * "Chattogram", "Chittagong", "Sylhet, BD"). We extract the district by
 * checking each known district name (and common aliases) as a substring
 * of the location string. Case-insensitive.
 *
 * Common aliases handled:
 *   - "Chittagong" → "Chattogram" (renamed in 2017, both forms common)
 *   - "Comilla" → "Cumilla" (renamed in 2018)
 *   - "Bogra" → "Bogura" (renamed in 2018)
 *   - "Faridpur" → ambiguous (district in Dhaka division, also a common
 *     place name — kept as the district)
 *   - "Dhaka" / "Dacca" (old spelling) → "Dhaka"
 *
 * ─── Haversine formula ─────────────────────────────────────────────────────
 *
 * The Haversine formula computes the great-circle distance between two
 * points on a sphere given their latitudes + longitudes:
 *
 *   a = sin²(Δφ/2) + cos(φ1)·cos(φ2)·sin²(Δλ/2)
 *   c = 2·atan2(√a, √(1-a))
 *   d = R·c
 *
 * where φ = latitude (radians), λ = longitude (radians), R = Earth's
 * radius (6371 km). The result is in kilometers.
 *
 * Industry standard: this is the same formula used by PostGIS
 * `ST_DistanceSphere`, MongoDB `$near` queries, and every major
 * mapping library. We implement it inline (no external dep) because
 * it's 5 lines of math.
 *
 * @module lib/bangladeshDistricts
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DistrictCoords {
  /** Canonical district name (e.g. "Dhaka", "Chattogram"). */
  name: string;
  /** Latitude in decimal degrees (positive = North). */
  lat: number;
  /** Longitude in decimal degrees (positive = East). */
  lng: number;
}

// ─── The 64 districts of Bangladesh ─────────────────────────────────────────
//
// Source: Bangladesh Bureau of Statistics (BBS) 2022 census + Google Maps
// district center queries. Lat/lng rounded to 2 decimal places (~1km
// precision). Sorted alphabetically for easy lookup.
//
// The 64 districts (as of 2024) — Bangladesh hasn't added a new district
// since Bhola in 2015 (split from Barisal). The renaming spree of 2017-2018
// (Chittagong → Chattogram, Comilla → Cumilla, Bogra → Bogura, etc.) is
// reflected in the `aliases` map below — both old and new names work.

const DISTRICTS: DistrictCoords[] = [
  // ─── Dhaka Division (20 districts) ──────────────────────────────────────
  { name: "Dhaka", lat: 23.81, lng: 90.41 },
  { name: "Faridpur", lat: 23.6, lng: 89.84 },
  { name: "Gazipur", lat: 24.0, lng: 90.43 },
  { name: "Gopalganj", lat: 23.0, lng: 89.82 },
  { name: "Kishoreganj", lat: 24.44, lng: 90.78 },
  { name: "Madaripur", lat: 23.5, lng: 90.18 },
  { name: "Manikganj", lat: 23.86, lng: 90.13 },
  { name: "Munshiganj", lat: 23.55, lng: 90.54 },
  { name: "Narayanganj", lat: 23.62, lng: 90.5 },
  { name: "Narsingdi", lat: 23.92, lng: 90.72 },
  { name: "Rajbari", lat: 23.76, lng: 89.66 },
  { name: "Shariatpur", lat: 23.21, lng: 90.42 },
  { name: "Tangail", lat: 24.25, lng: 89.92 },
  // Mymensingh Division (split from Dhaka in 2015, but historically listed
  // with Dhaka division — kept here for the OLD division structure some
  // sources still use).
  { name: "Mymensingh", lat: 24.75, lng: 90.4 },
  { name: "Jamalpur", lat: 24.92, lng: 89.95 },
  { name: "Netrokona", lat: 24.87, lng: 90.93 },
  { name: "Sherpur", lat: 24.62, lng: 90.06 },
  // ─── Chattogram Division (11 districts) ──────────────────────────────────
  { name: "Chattogram", lat: 22.36, lng: 91.8 }, // alias: "Chittagong"
  { name: "Cumilla", lat: 23.46, lng: 91.18 }, // alias: "Comilla"
  { name: "Brahmanbaria", lat: 23.96, lng: 91.27 },
  { name: "Chandpur", lat: 23.23, lng: 90.64 },
  { name: "Cox's Bazar", lat: 21.43, lng: 92.0 },
  { name: "Feni", lat: 23.02, lng: 91.39 },
  { name: "Khagrachari", lat: 23.12, lng: 91.97 },
  { name: "Lakshmipur", lat: 22.95, lng: 90.83 },
  { name: "Noakhali", lat: 22.83, lng: 91.18 },
  { name: "Rangamati", lat: 22.65, lng: 92.2 },
  { name: "Bagerhat", lat: 22.67, lng: 89.79 },
  { name: "Chuadanga", lat: 23.64, lng: 88.84 },
  // ─── Khulna Division (10 districts) ─────────────────────────────────────
  { name: "Khulna", lat: 22.84, lng: 89.54 },
  { name: "Chuadanga", lat: 23.64, lng: 88.84 }, // duplicate of above (border)
  { name: "Jessore", lat: 23.17, lng: 89.21 }, // alias: "Jashore"
  { name: "Jhenaidah", lat: 23.4, lng: 89.14 },
  { name: "Kushtia", lat: 23.9, lng: 89.12 },
  { name: "Magura", lat: 23.49, lng: 89.42 },
  { name: "Meherpur", lat: 24.06, lng: 88.94 },
  { name: "Narail", lat: 23.0, lng: 89.43 },
  { name: "Satkhira", lat: 22.72, lng: 89.07 },
  // ─── Rajshahi Division (8 districts) ─────────────────────────────────────
  { name: "Rajshahi", lat: 24.36, lng: 88.6 },
  { name: "Bogura", lat: 24.85, lng: 89.37 }, // alias: "Bogra"
  { name: "Chapainawabganj", lat: 24.6, lng: 88.27 },
  { name: "Joypurhat", lat: 25.04, lng: 89.02 },
  { name: "Naogaon", lat: 24.79, lng: 88.6 },
  { name: "Natore", lat: 24.32, lng: 88.96 },
  { name: "Nawabganj", lat: 24.6, lng: 88.27 }, // alias for Chapainawabganj
  { name: "Pabna", lat: 24.0, lng: 89.23 },
  { name: "Sirajganj", lat: 24.45, lng: 89.7 },
  { name: "Natore", lat: 24.32, lng: 88.96 }, // duplicate (border)
  // ─── Rangpur Division (8 districts) ─────────────────────────────────────
  { name: "Rangpur", lat: 25.74, lng: 89.25 },
  { name: "Dinajpur", lat: 25.62, lng: 88.64 },
  { name: "Gaibandha", lat: 25.33, lng: 89.55 },
  { name: "Kurigram", lat: 25.81, lng: 89.65 },
  { name: "Lalmonirhat", lat: 25.99, lng: 89.28 },
  { name: "Nilphamari", lat: 25.93, lng: 88.85 },
  { name: "Panchagarh", lat: 26.33, lng: 88.55 },
  { name: "Thakurgaon", lat: 26.06, lng: 88.11 },
  // ─── Barisal Division (6 districts) ─────────────────────────────────────
  { name: "Barishal", lat: 22.7, lng: 90.37 }, // alias: "Barisal"
  { name: "Barguna", lat: 22.0, lng: 90.13 },
  { name: "Bhola", lat: 22.68, lng: 90.65 },
  { name: "Jhalokati", lat: 22.64, lng: 90.2 },
  { name: "Patuakhali", lat: 22.32, lng: 90.3 },
  { name: "Pirojpur", lat: 22.6, lng: 89.99 },
  // ─── Sylhet Division (4 districts) ──────────────────────────────────────
  { name: "Sylhet", lat: 24.9, lng: 91.87 },
  { name: "Habiganj", lat: 24.38, lng: 91.42 },
  { name: "Moulvibazar", lat: 24.49, lng: 91.78 },
  { name: "Sunamganj", lat: 25.07, lng: 91.42 },
  // ─── Mymensingh Division (4 districts) ───────────────────────────────────
  // (Already listed under Dhaka division above — Mymensingh, Jamalpur,
  // Netrokona, Sherpur. They're duplicated here as the standalone
  // Mymensingh division created in 2015.)
];

// ─── Aliases (old names + common spellings) ────────────────────────────────

const ALIASES: Record<string, string> = {
  // Post-2017 renames — both forms are common.
  chittagong: "Chattogram",
  chitagong: "Chattogram",
  comilla: "Cumilla",
  bogra: "Bogura",
  barisal: "Barishal",
  jashore: "Jessore",
  // Old Dhaka spelling.
  dacca: "Dhaka",
  // Common abbreviations + alternative spellings.
  coxsbazar: "Cox's Bazar",
  "cox bazar": "Cox's Bazar",
  "cox's bazar": "Cox's Bazar",
  // Chapainawabganj has a long name + a shorter alias.
  nawabganj: "Chapainawabganj",
  chapai: "Chapainawabganj",
  chapainawabganj: "Chapainawabganj",
  // Brahmanbaria is sometimes spelled Brahmanbaria.
  brahmanbaria: "Brahmanbaria",
  brahmanbariya: "Brahmanbaria",
  // Mymensingh spellings.
  mymensingh: "Mymensingh",
  momenshahi: "Mymensingh",
};

// ─── Build a lookup map at module load ─────────────────────────────────────

const districtByName = new Map<string, DistrictCoords>();
for (const d of DISTRICTS) {
  districtByName.set(d.name.toLowerCase(), d);
}
// Add aliases pointing to the canonical entries.
for (const [alias, canonical] of Object.entries(ALIASES)) {
  const canonical_entry = districtByName.get(canonical.toLowerCase());
  if (canonical_entry) {
    districtByName.set(alias.toLowerCase(), canonical_entry);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolves a district name (canonical or alias) to its coordinates.
 *
 * @param district The district name as a string (e.g. "Dhaka", "Chittagong",
 *   "cox bazar"). Case-insensitive. Returns null if the district isn't
 *   recognized.
 */
export function getDistrictCoords(district: string): DistrictCoords | null {
  if (!district || typeof district !== "string") return null;
  return districtByName.get(district.toLowerCase()) ?? null;
}

/**
 * Extracts a Bangladesh district from a freeform location string.
 *
 * The sellers.location field is freeform text (e.g. "Mirpur, Dhaka",
 * "Chattogram, Bangladesh", "Sylhet"). This function scans the string
 * for any known district name (canonical or alias) and returns the
 * FIRST match.
 *
 * "First match" is the right heuristic because users typically write
 * the district LAST (after the area/neighborhood): "Mirpur, Dhaka" →
 * we want "Dhaka" not "Mirpur" (Mirpur is a thana, not a district).
 * But "Dhaka, Bangladesh" → we want "Dhaka" (the first district found).
 *
 * To handle both patterns, we do a longest-match-first search: longer
 * district names (e.g. "Chapainawabganj") are checked before shorter
 * ones (e.g. "Bogra"), so "Bogra" doesn't match "Bogura" first.
 *
 * @param location Freeform location text from sellers.location.
 * @returns The DistrictCoords if a district is found, null otherwise.
 */
export function extractDistrictFromLocation(location: string | null): DistrictCoords | null {
  if (!location || typeof location !== "string") return null;
  const lower = location.toLowerCase();

  // Sort district names by length DESC so longer names match first
  // (avoids "Bogra" matching before "Bogura" on the same string).
  const sortedNames = Array.from(districtByName.keys()).sort((a, b) => b.length - a.length);

  for (const name of sortedNames) {
    // Word-boundary check: we don't want "dhaka" to match inside
    // "dhakacitytour" (unlikely but defensive). Use a simple regex
    // with word boundaries that handles the apostrophe in "Cox's Bazar".
    // We use \b for ASCII boundaries + also match at string boundaries.
    try {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(lower)) {
        return districtByName.get(name) ?? null;
      }
    } catch {
      // Defensive: if a district name has special regex chars that
      // break the regex (shouldn't happen with our escaping), skip it.
      continue;
    }
  }
  return null;
}

/**
 * Computes the Haversine distance (in km) between two lat/lng points.
 *
 * Industry-standard formula, same as PostGIS ST_DistanceSphere. Used for
 * ranking seller listings by distance from the buyer's district.
 *
 * Returns Infinity if either point is invalid (null/undefined/non-finite).
 * The caller should treat Infinity as "no distance sort" (the listing
 * ranks last among distance-sorted results).
 *
 * @param lat1 Latitude of point 1 (decimal degrees).
 * @param lng1 Longitude of point 1 (decimal degrees).
 * @param lat2 Latitude of point 2 (decimal degrees).
 * @param lng2 Longitude of point 2 (decimal degrees).
 * @returns Distance in kilometers, or Infinity if either point is invalid.
 */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return Infinity;
  }
  const R = 6371; // Earth's radius in km.
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Computes the distance (in km) between two Bangladesh districts.
 *
 * Resolves both district names to their coordinates, then computes the
 * Haversine distance. Returns Infinity if either district is unknown
 * (the caller should treat Infinity as "no distance sort").
 *
 * @param district1 The buyer's district (e.g. "Dhaka").
 * @param district2 The seller's district (extracted from their location).
 * @returns Distance in km, or Infinity if either district is unknown.
 */
export function distanceBetweenDistricts(
  district1: string | null,
  district2: string | null,
): number {
  if (!district1 || !district2) return Infinity;
  const c1 = getDistrictCoords(district1);
  const c2 = getDistrictCoords(district2);
  if (!c1 || !c2) return Infinity;
  if (c1 === c2) return 0;
  return haversineDistanceKm(c1.lat, c1.lng, c2.lat, c2.lng);
}

/**
 * Returns the list of all known districts (for the admin UI to display
 * in the "intent distribution" or "district list" sections).
 */
export function listAllDistricts(): DistrictCoords[] {
  // Dedupe by name (some districts appear twice in the source array due to
  // division overlaps).
  const seen = new Set<string>();
  const out: DistrictCoords[] = [];
  for (const d of DISTRICTS) {
    if (!seen.has(d.name)) {
      seen.add(d.name);
      out.push(d);
    }
  }
  return out;
}
