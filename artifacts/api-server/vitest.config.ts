import { defineConfig } from "vitest/config";

/**
 * Vitest config for real HTTP-level integration tests against the actual
 * Express app (routes, middleware, auth) driven through supertest, with a
 * real Postgres database underneath -- no mocking of the DB or of
 * requireAuth/requireSeller/requireAdmin.
 *
 * Sequential (fileParallelism: false) on purpose: multiple test files would
 * otherwise run as separate worker processes against the SAME database at
 * the same time, and several tests here deliberately share fixture rows
 * scoped by a fixed marker (see test/testDb.ts) rather than fully isolated
 * per-file schemas. Running files in sequence keeps that fixture model
 * simple and avoids cross-file interference, at the cost of some wall-clock
 * time -- an acceptable trade for a suite this size. Within a single file,
 * tests still run in the order they're declared (Vitest's default), which
 * matters for the setup/cleanup pattern each file uses.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    setupFiles: ["./test/setupEnv.ts"],
  },
});
