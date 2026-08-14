/**
 * Tests for Bug #6 fix: 6 admin routes were unreachable due to double /api/ prefix.
 *
 * The router is mounted at both /api AND /api/v1 (app.ts):
 *   app.use("/api/v1", router);
 *   app.use("/api", router);
 *
 * So a route registered as "/api/ai/admin/timeseries" becomes:
 *   /api/api/ai/admin/timeseries  (under /api mount)
 *   /api/v1/api/ai/admin/timeseries  (under /api/v1 mount)
 *
 * Both are 404. The fix: register routes WITHOUT the /api/ prefix,
 * matching the 8 routes that were already correct.
 *
 * This test file verifies that NO route in aiAdmin.ts uses the /api/
 * prefix (they should all start with /ai/admin/...).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/adminRoutePrefix.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

describe("Bug #6 fix: no admin routes use double /api/ prefix", () => {
  const source = fs.readFileSync(
    "/home/z/my-project/Trees-friend-/artifacts/api-server/src/routes/aiAdmin.ts",
    "utf8",
  );

  // Extract all route registrations: router.get("/path", ...), router.post(...), etc.
  const routePattern = /router\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  const routes: { method: string; path: string }[] = [];
  let match;
  while ((match = routePattern.exec(source)) !== null) {
    routes.push({ method: match[1], path: match[2] });
  }

  it("aiAdmin.ts has at least 20 routes registered", () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
  });

  it("NO route uses the /api/ prefix (all should start with /ai/admin/)", () => {
    const brokenRoutes = routes.filter((r) => r.path.startsWith("/api/"));
    expect(brokenRoutes).toEqual([]);
  });

  it("all routes start with /ai/admin/", () => {
    const nonAdminRoutes = routes.filter((r) => !r.path.startsWith("/ai/admin/"));
    expect(nonAdminRoutes).toEqual([]);
  });

  // The 6 routes that were broken in the original Bug #6 analysis.
  // After the fix, they should all be registered with the correct path.
  describe("previously broken routes are now correctly registered", () => {
    const fixedRoutes = [
      "/ai/admin/timeseries",
      "/ai/admin/top-questions",
      "/ai/admin/top-products",
      "/ai/admin/feedback",
      "/ai/admin/pii-stats",
      "/ai/admin/top-questions-v2",
    ];

    for (const path of fixedRoutes) {
      it(`registers ${path} (without /api/ prefix)`, () => {
        const found = routes.some((r) => r.path === path);
        expect(found).toBe(true);
      });
    }
  });

  describe("the /api/ prefix no longer appears in any route registration", () => {
    it("no router.get/post/put/delete call has '/api/ai/admin/' as the path", () => {
      // This regex matches the broken pattern: router.METHOD("/api/ai/admin/...")
      const brokenPattern = /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\//;
      expect(brokenPattern.test(source)).toBe(false);
    });
  });
});

describe("Bug #6 fix: app.ts mounts router at /api and /api/v1", () => {
  // Verify the mount points haven't changed (they're the reason the
  // /api/ prefix in route registrations caused the double-/api/ bug).
  const source = fs.readFileSync(
    "/home/z/my-project/Trees-friend-/artifacts/api-server/src/app.ts",
    "utf8",
  );

  it("app.ts mounts router at /api", () => {
    expect(source).toContain('app.use("/api", router)');
  });

  it("app.ts mounts router at /api/v1", () => {
    expect(source).toContain('app.use("/api/v1", router)');
  });
});
