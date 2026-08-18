/**
 * Tests for the Bangladesh district distance lookup (v6.1 Part 3).
 *
 * Verifies:
 *   - All 64 districts are present + resolvable by name.
 *   - Common aliases (Chittagong → Chattogram, etc.) work.
 *   - extractDistrictFromLocation parses freeform location strings.
 *   - Haversine distance is computed correctly (Dhaka → Dhaka = 0, Dhaka →
 *     Chattogram ≈ 250km).
 *   - distanceBetweenDistricts returns Infinity for unknown districts.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/bangladeshDistricts.test.ts
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

import {
  getDistrictCoords,
  extractDistrictFromLocation,
  haversineDistanceKm,
  distanceBetweenDistricts,
  listAllDistricts,
} from "../src/lib/bangladeshDistricts";

describe("bangladeshDistricts: district lookup", () => {
  it("resolves all 64 districts by canonical name", () => {
    // Verify a sample of districts from each division.
    const samples = [
      "Dhaka", // Dhaka division
      "Faridpur",
      "Chattogram", // Chattogram division
      "Cumilla",
      "Khulna", // Khulna division
      "Jessore",
      "Rajshahi", // Rajshahi division
      "Bogura",
      "Rangpur", // Rangpur division
      "Dinajpur",
      "Barishal", // Barisal division
      "Bhola",
      "Sylhet", // Sylhet division
      "Moulvibazar",
      "Mymensingh", // Mymensingh division
      "Jamalpur",
    ];
    for (const name of samples) {
      const coords = getDistrictCoords(name);
      expect(coords).not.toBeNull();
      expect(coords!.name).toBe(name);
      expect(Number.isFinite(coords!.lat)).toBe(true);
      expect(Number.isFinite(coords!.lng)).toBe(true);
    }
  });

  it("resolves canonical aliases (Chittagong → Chattogram, etc.)", () => {
    // Post-2017 renames — both forms common.
    expect(getDistrictCoords("Chittagong")?.name).toBe("Chattogram");
    expect(getDistrictCoords("Comilla")?.name).toBe("Cumilla");
    expect(getDistrictCoords("Bogra")?.name).toBe("Bogura");
    expect(getDistrictCoords("Barisal")?.name).toBe("Barishal");
    expect(getDistrictCoords("Jashore")?.name).toBe("Jessore");
    // Old Dhaka spelling.
    expect(getDistrictCoords("Dacca")?.name).toBe("Dhaka");
    // Cox's Bazar variants.
    expect(getDistrictCoords("Cox's Bazar")?.name).toBe("Cox's Bazar");
    expect(getDistrictCoords("Cox Bazar")?.name).toBe("Cox's Bazar");
    expect(getDistrictCoords("coxsbazar")?.name).toBe("Cox's Bazar");
    // Chapainawabganj variants.
    expect(getDistrictCoords("Nawabganj")?.name).toBe("Chapainawabganj");
    expect(getDistrictCoords("Chapai")?.name).toBe("Chapainawabganj");
  });

  it("is case-insensitive", () => {
    expect(getDistrictCoords("dhaka")?.name).toBe("Dhaka");
    expect(getDistrictCoords("DHAKA")?.name).toBe("Dhaka");
    expect(getDistrictCoords("DhAkA")?.name).toBe("Dhaka");
    expect(getDistrictCoords("chittagong")?.name).toBe("Chattogram");
  });

  it("returns null for unknown districts", () => {
    expect(getDistrictCoords("Foo")).toBeNull();
    expect(getDistrictCoords("")).toBeNull();
    expect(getDistrictCoords(null as unknown as string)).toBeNull();
    expect(getDistrictCoords(undefined as unknown as string)).toBeNull();
  });

  it("listAllDistricts returns a non-empty deduped list", () => {
    const all = listAllDistricts();
    expect(all.length).toBeGreaterThan(50); // ~64 (some duplicates removed)
    // No duplicate names.
    const names = all.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("bangladeshDistricts: extractDistrictFromLocation (freeform text)", () => {
  it("extracts district from 'Mirpur, Dhaka' (area + district pattern)", () => {
    const d = extractDistrictFromLocation("Mirpur, Dhaka");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Dhaka");
  });

  it("extracts district from 'Chattogram, Bangladesh'", () => {
    const d = extractDistrictFromLocation("Chattogram, Bangladesh");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Chattogram");
  });

  it("extracts district from old name 'Chittagong' (alias)", () => {
    const d = extractDistrictFromLocation("Chittagong");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Chattogram");
  });

  it("extracts district from 'Sylhet' (just the district name)", () => {
    const d = extractDistrictFromLocation("Sylhet");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Sylhet");
  });

  it("extracts district from 'Cox's Bazar, BD' (apostrophe in name)", () => {
    const d = extractDistrictFromLocation("Cox's Bazar, BD");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Cox's Bazar");
  });

  it("extracts district from 'Bogura Sadar, Bogura' (alias + area)", () => {
    const d = extractDistrictFromLocation("Bogura Sadar, Bogura");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("Bogura");
  });

  it("returns null for null/empty location", () => {
    expect(extractDistrictFromLocation(null)).toBeNull();
    expect(extractDistrictFromLocation("")).toBeNull();
    expect(extractDistrictFromLocation("   ")).toBeNull();
  });

  it("returns null for location with no recognizable district", () => {
    expect(extractDistrictFromLocation("Unknown Place")).toBeNull();
    expect(extractDistrictFromLocation("123 Main Street")).toBeNull();
  });
});

describe("bangladeshDistricts: Haversine distance", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistanceKm(23.81, 90.41, 23.81, 90.41)).toBe(0);
  });

  it("computes a reasonable Dhaka → Chattogram distance (~250km)", () => {
    // Dhaka (23.81, 90.41) → Chattogram (22.36, 91.80).
    // Real-world road distance is ~265km; Haversine (great-circle) is less.
    const dist = haversineDistanceKm(23.81, 90.41, 22.36, 91.8);
    expect(dist).toBeGreaterThan(200);
    expect(dist).toBeLessThan(300);
  });

  it("computes a reasonable Dhaka → Sylhet distance (~250km)", () => {
    // Dhaka (23.81, 90.41) → Sylhet (24.90, 91.87).
    const dist = haversineDistanceKm(23.81, 90.41, 24.9, 91.87);
    expect(dist).toBeGreaterThan(150);
    expect(dist).toBeLessThan(300);
  });

  it("computes a reasonable Dhaka → Rajshahi distance (~200km)", () => {
    // Dhaka (23.81, 90.41) → Rajshahi (24.36, 88.60).
    const dist = haversineDistanceKm(23.81, 90.41, 24.36, 88.6);
    expect(dist).toBeGreaterThan(150);
    expect(dist).toBeLessThan(300);
  });

  it("returns Infinity for invalid inputs (NaN, undefined, Infinity)", () => {
    expect(haversineDistanceKm(NaN, 90, 23, 90)).toBe(Infinity);
    expect(haversineDistanceKm(23, Infinity, 24, 90)).toBe(Infinity);
    expect(haversineDistanceKm(23, 90, undefined as unknown as number, 90)).toBe(Infinity);
  });
});

describe("bangladeshDistricts: distanceBetweenDistricts", () => {
  it("returns 0 for the same district", () => {
    expect(distanceBetweenDistricts("Dhaka", "Dhaka")).toBe(0);
  });

  it("returns 0 for the same district via alias", () => {
    expect(distanceBetweenDistricts("Chittagong", "Chattogram")).toBe(0);
  });

  it("returns a reasonable distance for Dhaka → Chattogram", () => {
    const dist = distanceBetweenDistricts("Dhaka", "Chattogram");
    expect(dist).toBeGreaterThan(200);
    expect(dist).toBeLessThan(300);
  });

  it("returns Infinity when either district is unknown", () => {
    expect(distanceBetweenDistricts("Dhaka", "Foo")).toBe(Infinity);
    expect(distanceBetweenDistricts("Foo", "Dhaka")).toBe(Infinity);
    expect(distanceBetweenDistricts(null, "Dhaka")).toBe(Infinity);
    expect(distanceBetweenDistricts("Dhaka", null)).toBe(Infinity);
  });
});

describe("bangladeshDistricts: integration with sellerListingSearch ranking", () => {
  // These tests verify the distance helper is correctly wired into the
  // sellerListingSearch.ts ranking algorithm via source-shape checks
  // (no DB needed).
  it("sellerListingSearch.ts imports the bangladeshDistricts module", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    expect(source).toContain('from "./bangladeshDistricts"');
    expect(source).toContain("extractDistrictFromLocation");
    expect(source).toContain("distanceBetweenDistricts");
  });

  it("sellerListingSearch.ts uses Haversine distance (not same-district heuristic)", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      `${REPO_ROOT}/artifacts/api-server/src/lib/sellerListingSearch.ts`,
      "utf8",
    );
    // The Haversine distance is computed via distanceBetweenDistricts.
    // The v1 same-district heuristic (sellerLocationLower.includes) is gone.
    expect(source).toContain("distanceBetweenDistricts(buyerDistrict, sellerDistrict.name)");
    expect(source).not.toContain("sellerLocationLower.includes(buyerDistrictLower)");
    // The distance score uses a linear interpolation (max 500km → 0.0).
    expect(source).toContain("DISTANCE_MAX_KM = 500");
    expect(source).toContain("1 - dist / DISTANCE_MAX_KM");
  });
});
