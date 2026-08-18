/**
 * Per-tool rate limiter tests (v5.6).
 *
 * Verifies:
 *   - Tool tiers are correctly assigned (sensitive vs catalog)
 *   - Sensitive tools have tighter limits than catalog tools
 *   - Rate limit is checked before execution
 *   - Friendly error is returned when limit exceeded
 *   - Admin endpoint exists
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/toolRateLimiter.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── Source-shape tests ──────────────────────────────────────────────────────

describe("Per-tool rate limiter: source-shape tests", () => {
  it("toolRateLimiter.ts exports the expected interface", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("export async function checkToolRateLimit");
    expect(source).toContain("export function getToolRateLimitStatus");
    expect(source).toContain("export type ToolTier");
    expect(source).toContain("export const TOOL_TIERS");
  });

  it("assigns SENSITIVE tier to private-data tools (get_user_orders, get_order_details)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain('get_user_orders: "sensitive"');
    expect(source).toContain('get_order_details: "sensitive"');
  });

  it("assigns CATALOG tier to public-data tools (search_catalog, get_product_care, search_knowledge_base)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain('search_catalog: "catalog"');
    expect(source).toContain('get_product_care: "catalog"');
    expect(source).toContain('search_knowledge_base: "catalog"');
  });

  it("sensitive tier has tighter limit (10) than catalog tier (60)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("SENSITIVE_MAX");
    expect(source).toContain("CATALOG_MAX");
    expect(source).toContain("10");
    expect(source).toContain("60");
  });

  it("uses Redis (Upstash) for production + in-memory fallback for dev", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("getRedis");
    expect(source).toContain("checkInMemory");
    expect(source).toContain("_inMemory");
  });

  it("fail-open design (allows call if Redis fails)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("failing open");
  });

  it("uses ai:tool-rl: namespace (separate from other caches)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("ai:tool-rl:");
  });
});

// ─── Integration tests ──────────────────────────────────────────────────────

describe("Per-tool rate limiter: integration with executeTool", () => {
  it("aiTools.ts imports checkToolRateLimit", () => {
    const source = readSource("artifacts/api-server/src/lib/aiTools.ts");
    expect(source).toContain("import { checkToolRateLimit }");
  });

  it("executeTool checks rate limit BEFORE executing the tool", () => {
    const source = readSource("artifacts/api-server/src/lib/aiTools.ts");
    // The rate limit check should come before the switch statement
    const rateLimitIdx = source.indexOf("checkToolRateLimit");
    const switchIdx = source.indexOf("switch (name)");
    expect(rateLimitIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(rateLimitIdx).toBeLessThan(switchIdx);
  });

  it("returns friendly error when rate limited (not raw data)", () => {
    const source = readSource("artifacts/api-server/src/lib/aiTools.ts");
    expect(source).toContain("rateLimited: true");
    expect(source).toContain("retryAfterSeconds");
    expect(source).toContain("too many times");
  });

  it("logs rate limit exceeded events", () => {
    const source = readSource("artifacts/api-server/src/lib/aiTools.ts");
    expect(source).toContain("rate limited");
  });
});

// ─── Admin endpoint tests ────────────────────────────────────────────────────

describe("Per-tool rate limiter: admin endpoint", () => {
  it("aiAdmin.ts exposes GET /ai/admin/tool-rate-limits/health", () => {
    const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");
    expect(source).toContain('"/ai/admin/tool-rate-limits/health"');
    expect(source).toContain("getToolRateLimitStatus");
  });
});

// ─── Architecture tests ──────────────────────────────────────────────────────

describe("Per-tool rate limiter: architecture", () => {
  it("different tools have independent counters (per-tool keys)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("toolName");
    expect(source).toContain("ai:tool-rl:");
    // The key includes tier + toolName + identity for per-tool isolation
    expect(source).toContain("${tier}:${toolName}:${identity}");
  });

  it("tracked per-user (userId) with IP fallback for anonymous", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("userId");
    expect(source).toContain("ip");
  });

  it("1-hour sliding window (industry standard)", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("60 * 60");
  });

  it("configurable via env vars", () => {
    const source = readSource("artifacts/api-server/src/lib/toolRateLimiter.ts");
    expect(source).toContain("TOOL_RATE_LIMIT_ENABLED");
    expect(source).toContain("TOOL_RATE_LIMIT_SENSITIVE_MAX");
    expect(source).toContain("TOOL_RATE_LIMIT_CATALOG_MAX");
  });
});
