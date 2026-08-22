/**
 * Shared blog post helpers — used by BlogPage, BlogArticlePage, and the
 * admin BlogTab so read-time is formatted identically everywhere.
 *
 * Backend stores `read_time` as an integer (minutes). The admin form used to
 * accept free-text like "5 min read" and the backend stripped non-digits
 * with `replace(/\D/g, "")` — which corrupted ranges like "10-15 minutes"
 * into `1015`. This module is the single source of truth for parsing and
 * formatting, used by both the frontend and (mirrored) the backend so the
 * two never drift.
 */

/** Minimum sane read time (minutes). Anything below 1 is meaningless. */
export const MIN_READ_TIME = 1;
/** Maximum sane read time (minutes). ~10 hours; guards against absurd typos. */
export const MAX_READ_TIME = 600;
/** Default read time when the input is empty/unparseable. */
export const DEFAULT_READ_TIME = 5;

/**
 * Parse arbitrary admin input into a valid integer read time (minutes).
 *
 * Extracts the FIRST contiguous run of digits — so "10-15 minutes" → 10
 * (not 1015), "5 min read" → 5, "ten" → default. Clamps to [MIN, MAX].
 * Returns the default if no digits are found.
 *
 * @param input - Raw admin input (string, number, null, or undefined).
 * @returns Integer minutes in [MIN_READ_TIME, MAX_READ_TIME].
 */
export function parseReadTimeInput(input: unknown): number {
  if (input == null) return DEFAULT_READ_TIME;
  const str = String(input).trim();
  if (str === "") return DEFAULT_READ_TIME;
  const match = str.match(/\d+/);
  if (!match) return DEFAULT_READ_TIME;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n)) return DEFAULT_READ_TIME;
  return Math.min(MAX_READ_TIME, Math.max(MIN_READ_TIME, n));
}

/**
 * Format a read-time (minutes) into a display string.
 *
 * Follows the Medium/Substack convention: "5 min read" with no
 * pluralization ("1 min read", not "1 min read" → "1 minute read").
 * Returns an empty string for null/undefined/zero/non-finite so the
 * caller can choose to hide the element entirely.
 *
 * @param minutes - Read time in minutes (from API: integer).
 * @returns Display string like "5 min read", or "" if invalid.
 */
export function formatReadTime(
  minutes: number | null | undefined,
): string {
  if (minutes == null) return "";
  const n = typeof minutes === "number" ? minutes : Number(minutes);
  if (!Number.isFinite(n) || n < 1) return "";
  return `${Math.floor(n)} min read`;
}
