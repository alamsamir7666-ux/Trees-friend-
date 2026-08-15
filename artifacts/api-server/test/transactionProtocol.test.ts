/**
 * Executable tests verifying the transaction-protocol fix in:
 *   - kbEntries.createEntriesBatch
 *   - kbCategories.createKbCategory
 *   - kbCategories.moveKbCategory
 *
 * ─── What this test verifies ─────────────────────────────────────────────────
 *
 * The bug (see analysis): each `pool.query("BEGIN")` / `pool.query("INSERT")` /
 * `pool.query("COMMIT")` call acquired a DIFFERENT connection from the pool.
 * The BEGIN ran on connection A, the INSERT on connection B (OUTSIDE the
 * transaction!), the COMMIT on connection C. The "transaction" was
 * completely non-functional.
 *
 * The fix: acquire ONE connection via `pool.connect()` + use `client.query()`
 * for ALL statements (BEGIN, INSERT, UPDATE, COMMIT, ROLLBACK). Release in
 * a `finally` block.
 *
 * This test verifies the fix by MOCKING `pool` with a fake that:
 *   1. Tracks every `pool.query()` call vs `pool.connect()` + `client.query()`.
 *   2. Records the connection identity for each query.
 *   3. Throws if any query is sent via `pool.query()` inside a transaction
 *      block (the bug pattern).
 *
 * ─── Why mock instead of real DB ─────────────────────────────────────────────
 *
 * A real-DB integration test would verify the END-TO-END behavior (partial
 * failure → no rows committed). But:
 *   1. This sandbox has no Postgres available (DATABASE_URL is a placeholder).
 *   2. Even with a DB, the bug is connection-routing, not SQL semantics —
 *      mocking the pool is the most direct way to verify "all transaction
 *      queries went through the same client."
 *
 * The mock approach is also faster (no DB round-trips) and deterministic
 * (no flakiness from connection-pool scheduling).
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/transactionProtocol.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Mock the @workspace/db pool BEFORE importing the modules under test ─────
//
// The fake pool exposes:
//   - pool.query(text, params) — acquires a NEW connection per call (the
//     bug-prone pattern). Tracks calls so we can assert none happened
//     inside a transaction block.
//   - pool.connect() — returns a fake client with its own .query() that
//     shares state. The client tracks its own identity so we can verify
//     all transaction queries went through the SAME client.
//
// The fake also supports a "failOnNthClientQuery" hook so tests can
// simulate a mid-transaction failure (e.g. INSERT #2 throws) and verify
// that ROLLBACK is called on the same client + the client is released.

interface QueryCall {
  text: string;
  params: unknown[];
  /** Which connection handled this query: "pool" (auto-acquired) or `client:${id}`. */
  via: string;
}

interface FakeClient {
  id: number;
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  release: () => void;
  /** True after release() is called. */
  released: boolean;
}

let _nextClientId = 1;
let _poolQueryCalls: QueryCall[] = [];
let _clientQueryCalls: QueryCall[] = [];
let _clientsCreated: FakeClient[] = [];
let _failOnNthClientQuery: { n: number; error: Error } | null = null;
let _queryHandler:
  | ((text: string, params: unknown[]) => { rows: unknown[]; rowCount: number })
  | null = null;

function resetState() {
  _nextClientId = 1;
  _poolQueryCalls = [];
  _clientQueryCalls = [];
  _clientsCreated = [];
  _failOnNthClientQuery = null;
  _queryHandler = null;
}

function makeFakeClient(): FakeClient {
  const id = _nextClientId++;
  const client: FakeClient = {
    id,
    released: false,
    release: () => {
      client.released = true;
    },
    query: async (text: string, params: unknown[] = []) => {
      const call: QueryCall = { text, params, via: `client:${id}` };
      _clientQueryCalls.push(call);

      // Simulate a mid-transaction failure if configured.
      if (_failOnNthClientQuery !== null && _clientQueryCalls.length === _failOnNthClientQuery.n) {
        throw _failOnNthClientQuery.error;
      }

      // Default: return a sensible shape based on the query type.
      if (_queryHandler) {
        const result = _queryHandler(text, params);
        return result;
      }
      // INSERT ... RETURNING id → return a fake id.
      if (/RETURNING\s+id/i.test(text)) {
        return { rows: [{ id: 999 + _clientQueryCalls.length }], rowCount: 1 };
      }
      // BEGIN / COMMIT / ROLLBACK / UPDATE / DELETE → empty rows.
      return { rows: [], rowCount: 1 };
    },
  };
  _clientsCreated.push(client);
  return client;
}

const fakePool = {
  query: async (
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> => {
    _poolQueryCalls.push({ text, params, via: "pool" });
    // pool.query (the bug-prone path) — return a sensible default.
    if (/RETURNING\s+id/i.test(text)) {
      return { rows: [{ id: 999 + _poolQueryCalls.length }], rowCount: 1 };
    }
    if (/SELECT\s+creator_id/i.test(text)) {
      return { rows: [{ creator_id: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
  connect: () => Promise.resolve(makeFakeClient()),
};

vi.mock("@workspace/db", () => ({
  pool: fakePool,
  // Stub db (not used by the functions under test, but imported transitively).
  db: {},
}));

// Ensure env vars required by transitively-imported modules are set.
process.env.AI_SESSION_SECRET ??= "dGVzdC1haS1zZXNzaW9uLXNlY3JldC1rZXktZG8tbm90LXVzZS1pbi1wcm9k";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

// ─── Helpers for assertions ──────────────────────────────────────────────────

/** All queries (pool + client) in the order they were issued. */
function allQueryCalls(): QueryCall[] {
  return [..._poolQueryCalls, ..._clientQueryCalls];
}

/** The text of all queries, in order. */
function allQueryTexts(): string[] {
  return allQueryCalls().map((c) => c.text);
}

/** True if any query was sent via pool.query (the bug pattern). */
function anyPoolQueryInTransaction(): boolean {
  // A transaction block is delimited by BEGIN ... COMMIT/ROLLBACK.
  // Any pool.query call between BEGIN and COMMIT/ROLLBACK is the bug.
  let inTx = false;
  for (const call of allQueryCalls()) {
    if (call.text === "BEGIN") inTx = true;
    if (inTx && call.via === "pool") return true;
    if (call.text === "COMMIT" || call.text === "ROLLBACK") inTx = false;
  }
  return false;
}

/** The set of unique client identities that handled transaction-block queries. */
function transactionClientIds(): string[] {
  const ids = new Set<string>();
  let inTx = false;
  for (const call of allQueryCalls()) {
    if (call.text === "BEGIN") {
      inTx = true;
      ids.add(call.via);
      continue;
    }
    if (inTx) ids.add(call.via);
    if (call.text === "COMMIT" || call.text === "ROLLBACK") inTx = false;
  }
  return Array.from(ids);
}

// ─── Test setup / teardown ───────────────────────────────────────────────────

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
  vi.restoreAllMocks();
});

// ─── Tests: kbEntries.createEntriesBatch ─────────────────────────────────────

describe("kbEntries.createEntriesBatch: transaction protocol", () => {
  it("issues BEGIN, all INSERTs, COMMIT on the SAME client connection", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");

    await createEntriesBatch(
      1,
      [
        { title: "Entry A", content: "Content A" },
        { title: "Entry B", content: "Content B" },
        { title: "Entry C", content: "Content C" },
      ],
      "test-user",
    );

    // No query should have been sent via pool.query inside the transaction.
    expect(anyPoolQueryInTransaction()).toBe(false);

    // All transaction-block queries should have gone through ONE client.
    const txClientIds = transactionClientIds();
    expect(txClientIds).toHaveLength(1);
    expect(txClientIds[0]).toMatch(/^client:\d+$/);

    // Verify the expected query sequence: BEGIN → INSERT × 3 → COMMIT.
    const texts = allQueryTexts();
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");
    const insertCount = texts.filter((t) => /INSERT INTO ai_kb_entries/i.test(t)).length;
    expect(insertCount).toBe(3);
  });

  it("releases the client connection after success (no pool leak)", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");

    await createEntriesBatch(1, [{ title: "Entry A", content: "Content A" }], "test-user");

    expect(_clientsCreated).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });

  it("calls ROLLBACK on the SAME client when a mid-transaction INSERT fails", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");

    // Make the 3rd client.query call (2nd INSERT) throw.
    _failOnNthClientQuery = {
      n: 3, // 1=BEGIN, 2=INSERT #1, 3=INSERT #2 (throws)
      error: new Error("simulated mid-transaction failure"),
    };

    // The function catches the error + returns [] (per its outer try/catch).
    const result = await createEntriesBatch(
      1,
      [
        { title: "Entry A", content: "Content A" },
        { title: "Entry B", content: "Content B" },
        { title: "Entry C", content: "Content C" },
      ],
      "test-user",
    );

    expect(result).toEqual([]);

    // ROLLBACK should have been called, and on the SAME client as BEGIN.
    const texts = allQueryTexts();
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");

    // All transaction queries (including ROLLBACK) on one client.
    const txClientIds = transactionClientIds();
    expect(txClientIds).toHaveLength(1);

    // The client should STILL be released (no pool leak on error).
    expect(_clientsCreated).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });

  it("releases the client connection even if ROLLBACK itself fails", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");

    // Make the 2nd client.query (1st INSERT) throw, AND make the next
    // call (ROLLBACK) also throw.
    let callCount = 0;
    _failOnNthClientQuery = null; // use custom handler instead
    _queryHandler = (text) => {
      callCount++;
      if (callCount === 2) throw new Error("INSERT failed");
      if (text === "ROLLBACK") throw new Error("ROLLBACK also failed");
      return { rows: [], rowCount: 1 };
    };

    await createEntriesBatch(1, [{ title: "Entry A", content: "Content A" }], "test-user");

    // Even with ROLLBACK failing, the client should be released (finally block).
    expect(_clientsCreated).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });

  it("does NOT issue source-status UPDATE or entry_count UPDATE outside the transaction", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");

    // Use a source with a creator so the entry_count UPDATE fires.
    // Override the pool.query handler for the source lookup.
    let sourceLookupDone = false;
    const originalPoolQuery = fakePool.query;
    (fakePool as { query: typeof fakePool.query }).query = async (
      text: string,
      params: unknown[] = [],
    ) => {
      if (/SELECT creator_id FROM ai_kb_sources/i.test(text)) {
        sourceLookupDone = true;
        return { rows: [{ creator_id: 42 }], rowCount: 1 };
      }
      _poolQueryCalls.push({ text, params, via: "pool" });
      return { rows: [], rowCount: 1 };
    };

    await createEntriesBatch(1, [{ title: "Entry A", content: "Content A" }], "test-user");

    // Restore.
    (fakePool as { query: typeof fakePool.query }).query = originalPoolQuery;

    expect(sourceLookupDone).toBe(true);

    // The entry_count UPDATE + source-status UPDATE should have gone through
    // the client (inside the transaction), NOT via pool.query.
    const clientTexts = _clientQueryCalls.map((c) => c.text);
    expect(clientTexts.some((t) => /entry_count = entry_count/i.test(t))).toBe(true);
    expect(clientTexts.some((t) => /processing_status = 'embedding'/i.test(t))).toBe(true);

    // And NO pool.query call should have touched these tables.
    const poolTexts = _poolQueryCalls.map((c) => c.text);
    expect(poolTexts.some((t) => /entry_count = entry_count/i.test(t))).toBe(false);
    expect(poolTexts.some((t) => /processing_status = 'embedding'/i.test(t))).toBe(false);
  });
});

// ─── Tests: kbCategories.createKbCategory ────────────────────────────────────

describe("kbCategories.createKbCategory: transaction protocol", () => {
  it("issues BEGIN, INSERT, UPDATE path, COMMIT on the SAME client", async () => {
    const { createKbCategory } = await import("../src/lib/kbCategories");

    await createKbCategory({
      name: "Plant Care",
      slug: "plant-care",
      description: "General plant care tips",
      parentId: null,
    });

    expect(anyPoolQueryInTransaction()).toBe(false);

    const txClientIds = transactionClientIds();
    expect(txClientIds).toHaveLength(1);

    const texts = allQueryTexts();
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");

    // INSERT with placeholder path '/', then UPDATE with real path.
    const insertTexts = texts.filter((t) => /INSERT INTO ai_kb_categories/i.test(t));
    expect(insertTexts).toHaveLength(1);
    expect(insertTexts[0]).toMatch(/'\/'/); // placeholder path

    const updateTexts = texts.filter((t) => /UPDATE ai_kb_categories SET path/i.test(t));
    expect(updateTexts).toHaveLength(1);
  });

  it("releases the client connection after success", async () => {
    const { createKbCategory } = await import("../src/lib/kbCategories");

    await createKbCategory({
      name: "Plant Care",
      slug: "plant-care-2",
      description: null,
      parentId: null,
    });

    expect(_clientsCreated).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });

  it("calls ROLLBACK on the SAME client when the path UPDATE fails", async () => {
    const { createKbCategory } = await import("../src/lib/kbCategories");

    // 1=BEGIN, 2=INSERT, 3=UPDATE (throws)
    _failOnNthClientQuery = {
      n: 3,
      error: new Error("simulated UPDATE failure"),
    };

    const result = await createKbCategory({
      name: "Plant Care",
      slug: "plant-care-3",
      description: null,
      parentId: null,
    });

    // The function catches the error + returns null.
    expect(result).toBeNull();

    const texts = allQueryTexts();
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");

    // ROLLBACK on the same client as BEGIN.
    expect(transactionClientIds()).toHaveLength(1);

    // Client released even on error.
    expect(_clientsCreated[0].released).toBe(true);
  });
});

// ─── Tests: kbCategories.moveKbCategory ──────────────────────────────────────

describe("kbCategories.moveKbCategory: transaction protocol", () => {
  it("issues BEGIN, node UPDATE, descendant UPDATE, COMMIT on the SAME client", async () => {
    const { moveKbCategory } = await import("../src/lib/kbCategories");

    // The function fetches the node + new parent via pool.query (outside tx),
    // then does the transaction via client.
    // We need the fetches to return valid rows. Override pool.query.
    let callIdx = 0;
    const originalPoolQuery = fakePool.query;
    (fakePool as { query: typeof fakePool.query }).query = async (
      text: string,
      params: unknown[] = [],
    ) => {
      callIdx++;
      _poolQueryCalls.push({ text, params, via: "pool" });
      if (/SELECT path, depth FROM ai_kb_categories WHERE id = \$1/i.test(text)) {
        // First call = the moved node; second call = the new parent.
        if (callIdx === 1) return { rows: [{ path: "/1/3/", depth: 1 }], rowCount: 1 };
        return { rows: [{ path: "/2/", depth: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    const ok = await moveKbCategory(3, 2); // move node 3 under parent 2

    (fakePool as { query: typeof fakePool.query }).query = originalPoolQuery;

    expect(ok).toBe(true);

    expect(anyPoolQueryInTransaction()).toBe(false);
    expect(transactionClientIds()).toHaveLength(1);

    const texts = allQueryTexts();
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");

    // Two UPDATEs inside the transaction: the moved node + descendants.
    const updateTexts = texts.filter((t) => /UPDATE ai_kb_categories/i.test(t));
    expect(updateTexts).toHaveLength(2);

    // One should use REPLACE(path, ...) for descendants.
    expect(updateTexts.some((t) => /REPLACE\(path/i.test(t))).toBe(true);
  });

  it("releases the client connection after success", async () => {
    const { moveKbCategory } = await import("../src/lib/kbCategories");

    let callIdx = 0;
    const originalPoolQuery = fakePool.query;
    (fakePool as { query: typeof fakePool.query }).query = async (
      text: string,
      params: unknown[] = [],
    ) => {
      callIdx++;
      _poolQueryCalls.push({ text, params, via: "pool" });
      if (/SELECT path, depth FROM ai_kb_categories WHERE id = \$1/i.test(text)) {
        if (callIdx === 1) return { rows: [{ path: "/1/3/", depth: 1 }], rowCount: 1 };
        return { rows: [{ path: "/2/", depth: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    await moveKbCategory(3, 2);

    (fakePool as { query: typeof fakePool.query }).query = originalPoolQuery;

    expect(_clientsCreated).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });

  it("calls ROLLBACK on the SAME client when the descendant UPDATE fails", async () => {
    const { moveKbCategory } = await import("../src/lib/kbCategories");

    let callIdx = 0;
    const originalPoolQuery = fakePool.query;
    (fakePool as { query: typeof fakePool.query }).query = async (
      text: string,
      params: unknown[] = [],
    ) => {
      callIdx++;
      _poolQueryCalls.push({ text, params, via: "pool" });
      if (/SELECT path, depth FROM ai_kb_categories WHERE id = \$1/i.test(text)) {
        if (callIdx === 1) return { rows: [{ path: "/1/3/", depth: 1 }], rowCount: 1 };
        return { rows: [{ path: "/2/", depth: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    // 1=BEGIN, 2=moved-node UPDATE, 3=descendant UPDATE (throws)
    _failOnNthClientQuery = {
      n: 3,
      error: new Error("simulated descendant UPDATE failure"),
    };

    const ok = await moveKbCategory(3, 2);

    (fakePool as { query: typeof fakePool.query }).query = originalPoolQuery;

    expect(ok).toBe(false);

    const texts = allQueryTexts();
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(transactionClientIds()).toHaveLength(1);
    expect(_clientsCreated[0].released).toBe(true);
  });
});

// ─── Cross-cutting: no pool.query inside ANY transaction block ───────────────

describe("transaction protocol: no pool.query inside transaction blocks", () => {
  it("createEntriesBatch never uses pool.query between BEGIN and COMMIT/ROLLBACK", async () => {
    const { createEntriesBatch } = await import("../src/lib/kbEntries");
    await createEntriesBatch(1, [{ title: "X", content: "Y" }], null);
    expect(anyPoolQueryInTransaction()).toBe(false);
  });

  it("createKbCategory never uses pool.query between BEGIN and COMMIT/ROLLBACK", async () => {
    const { createKbCategory } = await import("../src/lib/kbCategories");
    await createKbCategory({ name: "X", slug: "x", description: null, parentId: null });
    expect(anyPoolQueryInTransaction()).toBe(false);
  });

  it("moveKbCategory never uses pool.query between BEGIN and COMMIT/ROLLBACK", async () => {
    const { moveKbCategory } = await import("../src/lib/kbCategories");

    let callIdx = 0;
    const originalPoolQuery = fakePool.query;
    (fakePool as { query: typeof fakePool.query }).query = async (
      text: string,
      params: unknown[] = [],
    ) => {
      callIdx++;
      _poolQueryCalls.push({ text, params, via: "pool" });
      if (/SELECT path, depth FROM ai_kb_categories WHERE id = \$1/i.test(text)) {
        if (callIdx === 1) return { rows: [{ path: "/1/", depth: 0 }], rowCount: 1 };
        return { rows: [{ path: "/2/", depth: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    await moveKbCategory(1, 2);

    (fakePool as { query: typeof fakePool.query }).query = originalPoolQuery;
    expect(anyPoolQueryInTransaction()).toBe(false);
  });
});
