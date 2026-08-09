/**
 * Standardized response helpers for Express routes.
 *
 * ─── The problem this solves ────────────────────────────────────────────────
 *
 * The codebase had 4 different success-response shapes:
 *
 *   • `{ message: "..." }`     — 21 occurrences (newsletter, cart, etc.)
 *   • `{ ok: true }`           — 11 occurrences (push, presence, cron)
 *   • `{ success: true }`      —  2 occurrences (conversations, homepageSections)
 *   • domain-specific shapes   — many (e.g. `{ isFollowing: true }`)
 *
 * And DELETE always returned `200 { message: "..." }` instead of the HTTP-
 * standard `204 No Content`.
 *
 * This module provides thin helpers that enforce ONE convention going forward:
 *
 *   • `res.ok()`               — 200 with `{ ok: true }` (for action endpoints)
 *   • `res.created(body)`      — 201 with the created resource
 *   • `res.noContent()`        — 204 with no body (for DELETE / idempotent
 *                                mutations — the HTTP-standard way to say
 *                                "success, nothing to return")
 *   • `res.message(text)`      — 200 with `{ message: "..." }` (for endpoints
 *                                where the frontend shows the message in a
 *                                toast — kept for backward compat with the
 *                                21 existing call sites)
 *
 * ─── Migration strategy ─────────────────────────────────────────────────────
 *
 * Existing routes are NOT changed — their response shapes are part of the
 * public API contract and the frontend depends on them. New routes should
 * use these helpers. When a frontend change touches a route's response
 * handling, switch that route to the helpers at the same time.
 *
 * The helpers are added to Express's `Response` type via declaration
 * merging, so they're available as `res.ok()` / `res.noContent()` etc.
 * without any import at the call site.
 */

import type { Response, Request, NextFunction } from "express";

// ─── Declaration merging: add helpers to Express's Response type ─────────────
//
// We declare the helpers on the global Express Response type so they're
// available as `res.ok()` / `res.noContent()` etc. without any import at
// the call site. The augmentation is on Express's own `Response` interface
// (re-opened here via `declare module "express"`).

declare module "express" {
  interface Response {
    /**
     * 200 OK with `{ ok: true }` body. For action endpoints that don't
     * return a resource (subscribe, unsubscribe, mark-as-read, etc.).
     */
    ok(): Response;
    /**
     * 201 Created with the created resource as the body. For POST endpoints
     * that create a new resource.
     */
    created<T>(body: T): Response;
    /**
     * 204 No Content with no body. For DELETE endpoints and idempotent
     * mutations where the client doesn't need a response body. This is the
     * HTTP-standard way to signal "success, nothing to return".
     */
    noContent(): Response;
    /**
     * 200 OK with `{ message: "..." }` body. For endpoints where the
     * frontend shows the message in a toast. Kept for backward compat with
     * the 21 existing `{ message }` call sites.
     */
    message(text: string): Response;
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────
//
// We attach the helpers per-response (not on the prototype) so they work
// with any Express version + don't interfere with other middleware that
// might touch res.json. The implementation uses Object.assign so the
// helpers are properly typed on the augmented Response interface.

interface ResponseHelpers {
  ok(): Response;
  created<T>(body: T): Response;
  noContent(): Response;
  message(text: string): Response;
}

function makeHelpers(res: Response): ResponseHelpers {
  return {
    ok() {
      return res.status(200).json({ ok: true });
    },
    created<T>(body: T) {
      return res.status(201).json(body);
    },
    noContent() {
      return res.status(204).end();
    },
    message(text: string) {
      return res.status(200).json({ message: text });
    },
  };
}

/**
 * Express middleware that attaches the response helpers to every `res`.
 * Mount once at the app level (after body parsers, before routes):
 *
 *   import { responseHelpersMiddleware } from "./lib/responses";
 *   app.use(responseHelpersMiddleware);
 */
export function responseHelpersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  Object.assign(res, makeHelpers(res));
  next();
}
