/**
 * Stubs global.fetch for calls to Steadfast's courier API host ONLY, for
 * the duration of a single test. Every other fetch call (there shouldn't
 * be any others in the routes under test) is passed through to the real
 * global.fetch.
 *
 * Why this exists at all: routes/orderShipments.ts's book-courier route
 * really does call out to a live courier vendor's HTTP API
 * (lib/courierAdapters/steadfast.ts -> https://portal.packzy.com/api/v1)
 * as part of its real control flow -- there is no test/mock seam built
 * into the adapter itself, and there shouldn't be one added just to make
 * this suite's job easier (the task brief is explicit that route/adapter
 * logic should not be changed to be "more testable" absent a real bug).
 * Actually calling packzy.com from this test suite would be wrong on
 * every axis that matters: it requires real Steadfast merchant
 * credentials this sandbox doesn't have, it would make the test flaky and
 * dependent on a third party's uptime, and this environment's network
 * egress allowlist doesn't even permit the host.
 *
 * Stubbing at the network boundary (global.fetch), rather than mocking
 * getCourierAdapter/bookShipment or requireSeller/the DB, is the
 * narrowest possible substitution: every layer this test suite exists to
 * prove out -- Express routing, requireSeller/requireAuth, the real route
 * handler's SELECT-then-INSERT logic, the real order_shipments unique
 * constraint -- still runs unmodified and for real. Only the one external
 * I/O call this sandbox cannot make is replaced, exactly the way a
 * well-behaved integration test suite stubs an unreachable third-party
 * dependency without stubbing the system under test.
 */

const STEADFAST_HOST = "portal.packzy.com";

let installed = false;
let realFetch: typeof fetch;

/**
 * Optional synchronization barrier for concurrency tests. When set (via
 * installSteadfastFetchStub's `barrier` option), every stubbed call waits
 * on this shared promise before resolving -- so N concurrent callers can
 * be driven to all be "mid-flight inside adapter.bookShipment()" at the
 * same instant, then released together. Without this, two Promise.all'd
 * HTTP requests to an in-process Express app do NOT reliably race at the
 * DB layer: Node's event loop combined with this stack's timing let one
 * request's entire SELECT -> await fetch -> INSERT -> commit cycle finish
 * before the other's initial SELECT ever ran, every time this was
 * measured (see PART3_HANDOFF.md addendum) -- meaning the original
 * concurrency test exercised the route's own "already booked" pre-check,
 * never the order_shipments unique constraint it was written to prove.
 * A barrier closes that gap by holding both requests open across their
 * SELECT-existing-shipment checks, so both proceed to INSERT and the DB
 * constraint -- not request ordering -- decides the outcome.
 */
let barrierResolvers: Array<() => void> = [];
let barrierExpected = 0;

export function installSteadfastFetchStub(options?: { barrier?: number }): void {
  installed = true;
  realFetch = global.fetch;
  barrierExpected = options?.barrier ?? 0;
  barrierResolvers = [];

  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes(STEADFAST_HOST)) {
      if (barrierExpected > 0) {
        await new Promise<void>((resolve) => {
          barrierResolvers.push(resolve);
          if (barrierResolvers.length >= barrierExpected) {
            // Last caller to arrive releases everyone, itself included.
            const toRelease = barrierResolvers;
            barrierResolvers = [];
            toRelease.forEach((r) => r());
          }
        });
      }
      const consignmentId = `TEST-CONSIGNMENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body = { consignment: { consignment_id: consignmentId, tracking_code: consignmentId } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

export function uninstallSteadfastFetchStub(): void {
  if (!installed) return;
  global.fetch = realFetch;
  installed = false;
  barrierResolvers = [];
  barrierExpected = 0;
}
