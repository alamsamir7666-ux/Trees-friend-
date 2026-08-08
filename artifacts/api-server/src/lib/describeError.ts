/**
 * Normalize any thrown value (Error, string, object, unknown) into a string
 * suitable for both structured logging and (in non-production) the JSON
 * response body. Without this, thrown non-Error values serialize to `{}`,
 * which is exactly what was producing the empty `Error {}` in the browser
 * console for 500 responses.
 *
 * VAL-2: Moved from routes/conversations.ts (where it was a local function)
 * to lib/ so every route can reuse it instead of each catch block
 * reimplementing its own error normalization.
 */

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
