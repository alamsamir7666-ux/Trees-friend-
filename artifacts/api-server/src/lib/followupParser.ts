/**
 * Backend followup parser — mirrors the frontend's parseMessage.ts logic.
 *
 * Used by routes/ai.ts to check if the AI's response contains a valid
 * [followups]...[/followups] block. If not, the route calls
 * generateFollowupsStructured() to produce guaranteed-valid followups
 * via the provider's structured output API.
 *
 * This is intentionally a SEPARATE module from the frontend's parseMessage.ts
 * because:
 *   - The frontend runs in the browser (different module system)
 *   - The backend needs to import it in Node.js
 *   - The logic is simple enough to duplicate (and keeping them in sync
 *     is easy — they're both ~20 lines)
 *
 * If the parsing logic becomes more complex, extract to a shared package.
 */

const FOLLOWUPS_OPEN = "[followups]";
const FOLLOWUPS_CLOSE = "[/followups]";

/**
 * Extracts follow-up questions from a [followups]...[/followups] block.
 *
 * Returns { found: boolean, followups: string[] }.
 * If no block is found, returns { found: false, followups: [] }.
 * If the block is malformed (missing close tag, no items), returns
 * { found: false, followups: [] }.
 */
export function extractFollowups(content: string): {
  found: boolean;
  followups: string[];
} {
  const openIdx = content.indexOf(FOLLOWUPS_OPEN);
  if (openIdx === -1) {
    return { found: false, followups: [] };
  }

  const afterOpen = content.slice(openIdx + FOLLOWUPS_OPEN.length);
  const closeIdx = afterOpen.indexOf(FOLLOWUPS_CLOSE);

  const blockContent =
    closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx);

  // Parse each "- question" line
  const followups = blockContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 5);

  // If we found the block but no valid items, treat as not found
  return { found: followups.length > 0, followups };
}
