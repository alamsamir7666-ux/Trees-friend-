/**
 * Typed API request types (CQ-4).
 *
 * The engineering audit (Code Quality §B1) found 150 `req: any` annotations
 * across route handlers — 65% of routes lose type safety on `req`. The root
 * cause: Express 5's `Request` type is generic (`Request<P, ResBody, ReqBody, ReqQuery>`)
 * but routes annotate `req` as `any` to avoid fighting with the parameterized
 * types, especially when combined with the auth augmentation (`req.userId`,
 * `req.dbUser`, `req.dbSeller`).
 *
 * This module provides a typed request interface that combines the auth
 * augmentation with parameterized body/params/query types:
 *
 *   - `ApiRequest<TBody, TParams, TQuery>` — typed request for any route.
 *     The auth fields (`userId`, `dbUser`, `dbSeller`) are inherited from
 *     the global Express augmentation in auth.ts (where they're `?`
 *     optional, set by requireAuth at runtime). TBody defaults to `unknown`,
 *     TParams/TQuery default to `Record<string, string>`.
 *
 * Usage:
 *
 *   ```ts
 *   import type { ApiRequest } from "../types/apiRequest";
 *   import type { Response } from "express";
 *
 *   router.post("/orders", requireAuth, validateBody(CreateOrderBody), async (req: ApiRequest<z.infer<typeof CreateOrderBody>>, res: Response) => {
 *     // req.body is typed as z.infer<typeof CreateOrderBody>
 *     // req.userId is string | undefined (set by requireAuth at runtime)
 *     // req.dbUser is the users row type | undefined
 *     ...
 *   });
 *   ```
 *
 * Why are the auth fields still optional (`?`)?
 *   The global Express augmentation in auth.ts declares them as `?`
 *   because they're only set after requireAuth runs. Making them
 *   non-optional in a subtype would break Express's handler type
 *   signature (contravariance — the handler's parameter type can't be
 *   NARROWER than what Express passes). The standard pattern is to trust
 *   requireAuth at runtime and use `req.userId!` (non-null assertion) in
 *   handlers, or add an explicit `if (!req.userId) return res.status(401)`
 *   guard at the top of handlers that want compile-time safety.
 *
 * Why a separate type (not just `Request<TParams, any, TBody, TQuery>`)?
 *   1. Centralizes the body/params/query generics so routes don't repeat
 *      `Request<Params, any, Body, Query>` every time.
 *   2. Provides a clean migration path: routes can switch from `req: any`
 *      to `req: ApiRequest<...>` incrementally.
 *   3. The `unknown` default for TBody is safer than `any` — handlers
 *      must narrow the type before use (or rely on Zod validation to
 *      replace req.body with a typed value).
 */

import type { Request } from "express";
import type { usersTable, sellersTable } from "@workspace/db";

/**
 * Typed request for API routes. The auth fields (`userId`, `dbUser`,
 * `dbSeller`) are inherited from the global Express augmentation in
 * auth.ts — they're `?` optional there (set by requireAuth at runtime).
 *
 * @typeParam TBody  - The shape of `req.body` (defaults to `unknown`).
 * @typeParam TParams - The shape of `req.params` (defaults to `Record<string, string>`).
 * @typeParam TQuery  - The shape of `req.query` (defaults to `Record<string, unknown>`).
 */
export interface ApiRequest<
  TBody = unknown,
  TParams = Record<string, string>,
  TQuery = Record<string, unknown>,
> extends Request<TParams, unknown, TBody, TQuery> {
  // Auth fields inherited from the global Express augmentation in auth.ts.
  // Declared here so they appear in IDE autocomplete. Runtime type is `?`
  // optional (set by requireAuth) — handlers use `req.userId!` or add an
  // explicit guard when they need a non-undefined value.
  userId?: string;
  dbUser?: typeof usersTable.$inferSelect;
  dbSeller?: typeof sellersTable.$inferSelect;
}

