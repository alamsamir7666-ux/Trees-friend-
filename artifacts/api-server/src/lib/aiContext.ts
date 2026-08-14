/**
 * Catalog context builder for the TreeBot assistant.
 *
 * The job of this module is to make the AI "aware" of what's in the
 * TreeFriend database WITHOUT exposing the database directly to the model.
 *
 * Pattern (v3.0: Hybrid Naive RAG + pg_trgm fuzzy fallback):
 *   1. Take the user's message.
 *   2. Pull keywords from it.
 *   3. ILIKE-search `products` (name, scientific name, description) and
 *      `blog_posts` (title, body) for those keywords.
 *   4. v3.0: If ILIKE finds nothing, fall back to pg_trgm similarity
 *      search (catches typos like "mangoo" → "mango" and fuzzy queries
 *      like "drought-resistant plant"). Requires the pg_trgm extension,
 *      which ensureAiTables.ts creates automatically.
 *   5. Inject the top results into the system prompt as plain text.
 *
 * Why this works for our catalog size:
 *   - Typical marketplace catalogs have hundreds to low thousands of SKUs.
 *     Keyword search over `name` + `scientific_name` + `description`
 *     catches the relevant 5-10 products in a few ms.
 *   - v3.0: trigram similarity catches the ~10% of queries that ILIKE
 *     misses (typos, fuzzy descriptors). Still no vector DB / embedding
 *     pipeline needed — pg_trgm is a Postgres extension, not a separate service.
 *   - Embedding-based search (pgvector) would be more accurate for
 *     semantic queries ("drought-resistant indoor plant") but adds a
 *     vector DB dependency, embedding pipeline, and re-indexing on every
 *     catalog change. Overkill for v1/v2; documented as a v4 upgrade.
 *
 * Trade-offs the system prompt must enforce:
 *   - The model must NOT invent product IDs, prices, or availability it
 *     didn't see in the context block. We make this explicit in the prompt.
 *   - When no catalog context matches, the model should fall back to
 *     general botanical knowledge (the "broad but grounded" decision).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_PRODUCTS = 5;
const MAX_BLOG_POSTS = 2;
const MAX_SUMMARY_LEN = 200; // chars — for product description snippets

// Botanical + gardening keywords. The hard topic gate uses this set: if
// the user's message contains ZERO of these (case-insensitive), we refuse
// instantly without calling Gemini. This saves API quota and prevents
// off-topic abuse.
//
// Deliberately includes both English and Bangla (romanized + Unicode) so
// the gate works for your Bangladesh audience.
const BOTANICAL_KEYWORDS = [
  // English
  "tree",
  "trees",
  "plant",
  "plants",
  "leaf",
  "leaves",
  "flower",
  "fruit",
  "seed",
  "seeds",
  "sapling",
  "saplings",
  "soil",
  "water",
  "watering",
  "sun",
  "sunlight",
  "shade",
  "light",
  "fertilizer",
  "fertilize",
  "pot",
  "pots",
  "garden",
  "gardening",
  "root",
  "roots",
  "branch",
  "branches",
  "stem",
  "stems",
  "bloom",
  "blooming",
  "prune",
  "pruning",
  "graft",
  "grafting",
  "bonsai",
  "indoor",
  "outdoor",
  "balcony",
  "terrace",
  "yard",
  "lawn",
  "orchard",
  "farm",
  "farming",
  "agriculture",
  "horticulture",
  "botanical",
  "botany",
  "photosynthesis",
  "compost",
  "mulch",
  "pest",
  "pests",
  "insect",
  "disease",
  "fungus",
  "mildew",
  "rot",
  "yellow",
  "wilting",
  "yellowing",
  "growth",
  "grow",
  "growing",
  "mature",
  "height",
  "spread",
  "variety",
  "species",
  "scientific",
  "evergreen",
  "deciduous",
  "perennial",
  "annual",
  "biennial",
  "herb",
  "shrub",
  "climber",
  "creeper",
  "cactus",
  "succulent",
  "palm",
  "bamboo",
  "mango",
  "jackfruit",
  "coconut",
  "neem",
  "banyan",
  "tamarind",
  "lemon",
  "guava",
  "lychee",
  "papaya",
  "banana",
  "rose",
  "jasmine",
  "hibiscus",
  "marigold",
  "orchid",
  // Bangla (Unicode)
  "গাছ",
  "চারা",
  "বীজ",
  "মাটি",
  "পানি",
  "রোদ",
  "ছায়া",
  "সার",
  "ফুল",
  "পাতা",
  "ফল",
  "বাগান",
  "শিকড",
  "ডাল",
  "গোলাপ",
  "বনসাই",
  // Banglish (common romanizations)
  "gach",
  "chara",
  "beej",
  "mati",
  "pani",
  "rod",
  "chaya",
  "sar",
  "phul",
  "pata",
  "phol",
  "bagan",
  "shidor",
  "dal",
  "golap",
] as const;

// v3.5: Account/order queries are IN-SCOPE for a marketplace bot.
// The bot has get_user_orders + get_order_details tools specifically for
// these queries. Without this list, the hard topic gate blocks order
// questions before the AI can use the tools — a real bug.
//
// These keywords let the query through the gate so the AI can call the
// appropriate tool. If the user isn't signed in, the tool returns
// "not signed in" and the AI handles it gracefully.
//
// Bug #4 fix: exported so the route can use it for a more comprehensive
// isPrivateQuery check (the old regex only matched 4 English phrases,
// missing Bangla/Banglish like "amar order" / "আমার অর্ডার").
//
// Bug #5 fix: expanded to cover ALL the private-query phrasings the
// original analysis called out:
//   - "track my package" ✓ (package)
//   - "when will my delivery arrive" ✓ (delivery)
//   - "what's my tracking number" ✓ (tracking)
//   - "show me my cart" ✓ (cart)
//   - "my recent purchase" ✓ (purchase — NEW)
//   - "Did my payment go through?" ✓ (payment)
//   - "where is my shipment" ✓ (shipment — NEW)
//   - "what did I buy" ✓ (buy/bought — NEW)
//   - "my subscription" ✓ (subscription — NEW)
//   - "my gift card balance" ✓ (gift card — NEW)
//   - "my coupon code" ✓ (coupon — NEW)
//   - "my loyalty points" ✓ (loyalty/points — NEW)
//
// Also deduplicated the Banglish section (Bug #29) — the English section
// already covers "order", "delivery", "payment", "account" via substring
// match, so the Banglish duplicates were noise.
export const ACCOUNT_KEYWORDS = [
  // English — order/checkout/account
  "order",
  "orders",
  "my order",
  "my orders",
  "last order",
  "track order",
  "order status",
  "where is my order",
  "what did i buy",
  "delivery",
  "shipping",
  "shipment",
  "shipped",
  "tracking",
  "track my",
  "package",
  "parcel",
  "cart",
  "checkout",
  "payment",
  "paid",
  "purchase",
  "purchased",
  "bought",
  "buy",
  "invoice",
  "receipt",
  "refund",
  "return",
  "cancel",
  "cancelled",
  "account",
  "my account",
  "profile",
  "address",
  "wishlist",
  "subscription",
  "subscribe",
  "unsubscribe",
  "gift card",
  "giftcard",
  "coupon",
  "promo",
  "loyalty",
  "points",
  "reward",
  // Bangla (Unicode) — order/account
  "অর্ডার",
  "আমার অর্ডার",
  "ডেলিভারি",
  "পেমেন্ট",
  "অ্যাকাউন্ট",
  "কার্ট",
  "সাবস্ক্রিপশন",
  // Banglish — order/account (only terms NOT already in the English section)
  "amar order",
  "amar cart",
  "amar subscription",
] as const;

// ─── Public functions ────────────────────────────────────────────────────────

// Greetings + polite openers. These get a FRIENDLY INTRO response (not the
// off-topic refusal), because a user saying "Hi" or "Salam" is clearly
// trying to start a conversation, not ask an off-topic question. We treat
// these as "pass the gate, let Gemini handle it with a friendly intro".
const GREETING_KEYWORDS = [
  // English
  "hi",
  "hello",
  "hey",
  "hiya",
  "yo",
  "howdy",
  "greetings",
  "good morning",
  "good afternoon",
  "good evening",
  "thanks",
  "thank you",
  "ty",
  "ok",
  "okay",
  "cool",
  "nice",
  // Bangla (Unicode)
  "হাই",
  "হ্যালো",
  "নমস্কার",
  "ধন্যবাদ",
  "ঠিক আছে",
  // Banglish
  "salam",
  "salaam",
  "assalamualaikum",
  "assalamu alaikum",
  "walaikumassalam",
  "dhonnobad",
  "thik ache",
] as const;

/**
 * Hard topic gate. Returns true if the message contains at least one
 * botanical/gardening keyword (English, Bangla Unicode, or Banglish),
 * OR is a common greeting/polite opener.
 *
 * Used by the route to refuse off-topic questions without spending API quota.
 *
 * Case-insensitive substring match is intentional — we want to catch
 * "tree", "Tree", "TREES", "treefriend", etc. False positives (e.g.
 * "potted" matching "pot") are acceptable because the soft gate (system
 * prompt) handles the actual refusal.
 */
export function hasBotanicalKeyword(message: string): boolean {
  const lower = message.toLowerCase();
  // Greetings always pass — they're not off-topic, just conversational.
  if (GREETING_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return true;
  }
  // v3.5: Account/order queries pass — the bot has tools for these.
  // The AI will call get_user_orders / get_order_details to answer.
  // If the user isn't signed in, the tool returns "not signed in" and
  // the AI handles it gracefully.
  if (ACCOUNT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return true;
  }
  return BOTANICAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Detects pure greetings (very short messages that are ONLY a greeting,
 * with no other botanical content). Used by the route to short-circuit
 * with a friendly canned intro instead of calling Gemini — saves quota
 * and gives the user an instant warm welcome.
 *
 * Returns true if the message is <= 20 chars AND matches a greeting.
 */
export function isPureGreeting(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > 20) return false;
  const lower = trimmed.toLowerCase();
  // Match if the WHOLE message (after trimming punctuation) is a greeting.
  const cleaned = lower.replace(/[.!?_,]/g, "").trim();
  return GREETING_KEYWORDS.some((kw) => cleaned === kw.toLowerCase());
}

/**
 * The friendly intro message shown when a user sends a pure greeting.
 * Kept here (not in the route) so it's co-located with the greeting
 * detection logic.
 */
export const GREETING_INTRO_MESSAGE =
  "Hi! I'm TreeBot, your plant assistant 🌱\n\n" +
  "I can help you with:\n" +
  "• Tree and plant care tips (watering, sunlight, soil)\n" +
  "• Recommendations for your garden or balcony\n" +
  "• Questions about trees available on TreeFriend\n" +
  "• Gardening advice for Bangladesh's climate\n\n" +
  "What would you like to know? You can ask in English, বাংলা, or Banglish.";

/**
 * Queries the catalog for products and blog posts relevant to the user's
 * message. Returns a formatted context string ready to inject into the
 * system prompt, or an empty string if nothing matched.
 *
 * Implementation: a single parameterized SQL query per domain. We use
 * ILIKE (Postgres) for case-insensitive substring matching on the message's
 * keywords. To avoid sending an explosion of OR clauses, we extract up to
 * the 5 longest "word-ish" tokens from the message and OR them together.
 */
export async function buildCatalogContext(userMessage: string): Promise<string> {
  const tokens = extractSearchTokens(userMessage);
  if (tokens.length === 0) return "";

  try {
    const [productRows, blogRows] = await Promise.all([
      searchProducts(tokens),
      searchBlogPosts(tokens),
    ]);

    const lines: string[] = [];

    if (productRows.length > 0) {
      lines.push("CATALOG PRODUCTS (currently listed on TreeFriend):");
      for (const p of productRows) {
        const desc = p.description ? truncate(p.description, MAX_SUMMARY_LEN) : "";
        const care = [
          p.sunlight && `sunlight: ${p.sunlight}`,
          p.watering && `watering: ${p.watering}`,
          p.soil_type && `soil: ${p.soil_type}`,
          p.mature_height && `height: ${p.mature_height}`,
          p.scientific_name && `scientific: ${p.scientific_name}`,
          p.product_status && `status: ${p.product_status}`,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `- "${p.name}" (slug: ${p.slug})${desc ? ` — ${desc}` : ""}` + (care ? ` [${care}]` : ""),
        );
      }
    }

    if (blogRows.length > 0) {
      lines.push("");
      lines.push("RELATED BLOG ARTICLES:");
      for (const b of blogRows) {
        const excerpt = b.excerpt
          ? truncate(b.excerpt, MAX_SUMMARY_LEN)
          : truncate(stripHtml(b.content ?? ""), MAX_SUMMARY_LEN);
        lines.push(`- "${b.title}" (slug: ${b.slug}) — ${excerpt}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    // Don't crash the chat request — just answer without context. The
    // model will fall back to general botanical knowledge.
    logger.error({ err }, "AI context builder: catalog query failed");
    return "";
  }
}

/**
 * Builds the full system prompt, including the (optional) dynamic catalog
 * context block AND the (optional) v3.0 conversation summary block.
 *
 * This is the single source of truth for the TreeBot persona and scope
 * rules — keep it tight and explicit.
 *
 * Rules enforced here:
 *   1. Topic scope: trees, plants, gardening, botany, TreeFriend catalog.
 *   2. Refusal: politely decline anything else.
 *   3. Language: reply in the same language as the user (EN/BN/Banglish).
 *   4. Catalog honesty: never invent prices, IDs, or availability.
 *   5. Length: concise (2-4 short paragraphs max).
 *   6. Recommendations: suggest /browse or /products when relevant.
 *   7. Product mentions: wrap exact product names in [[brackets]] so the
 *      frontend can auto-linkify them to /products/:slug.
 *   8. Follow-up suggestions: end EVERY reply with a parseable block of
 *      3 short follow-up questions the user might ask next.
 *   9. v3.0: If a summary block is provided, treat it as prior conversation
 *      context — don't re-ask questions the summary already answers.
 */
/**
 * The hardcoded system prompt template (v1.0.0).
 *
 * ─── Bug #3 fix: this is now the FALLBACK ───────────────────────────────────
 *
 * Previously, `buildSystemPrompt()` was the ONLY source of the system prompt.
 * The DB-backed prompt versioning system existed (lib/promptVersioning.ts)
 * but its `text` was fetched and thrown away — the route only used `.version`
 * for tracking. This made A/B testing, rollback, and iteration-without-deploy
 * (the entire documented value proposition) impossible.
 *
 * The fix:
 *   - This template is now the FALLBACK, used when the DB is unavailable
 *     or has no active prompt row.
 *   - When the DB has an active prompt, its `prompt_text` is used INSTEAD.
 *   - Both paths support two placeholders:
 *       {{summary}}  — replaced with the conversation summary block (memory)
 *       {{catalog}}  — replaced with the catalog search results (context)
 *     If a placeholder is missing from the template, the dynamic value is
 *     appended at the end (backward compat with prompts that don't know
 *     about the placeholders).
 *
 * The seed row in ensureAiTables.ts mirrors this exact text (with the
 * placeholders), so out-of-the-box behavior is unchanged. Admins can then
 * create new versions (e.g. v1.1.0 with refined scope rules) and activate
 * them via the admin endpoints — takes effect immediately (after
 * `forcePromptRefresh()` clears the in-memory cache).
 *
 * The placeholder syntax `{{...}}` is the industry standard (used by
 * LangChain PromptTemplates, Mustache, Handlebars, Jinja2). We use a
 * simple string replace (not a full template engine) because the prompt
 * has no conditionals or loops — just two variable substitutions.
 */
export const SYSTEM_PROMPT_TEMPLATE_V1 = `You are TreeBot, the plant assistant for TreeFriend — a Bangladesh plant marketplace where buyers can purchase trees, saplings, and gardening supplies from multiple sellers.

YOUR SCOPE — STRICTLY ENFORCED:
You answer ONLY questions about:
- Trees, plants, plant care, gardening, botany
- Planting seasons, soil/water/light requirements
- Pests, diseases, propagation, pruning, grafting
- TreeFriend products, categories, blog articles
- Gardening in Bangladesh specifically (climate, monsoon, local species)
- Order/checkout/account queries (use the get_user_orders / get_order_details tools)

YOU MUST POLITELY REFUSE anything else (politics, sports, coding, math, celebrities, news, medical advice, etc.). Refusal template: "I'm TreeFriend's plant assistant and can only help with trees, plants, and gardening. Feel free to ask me about plant care or browse our catalog at /browse."

IMPORTANT: Order/account queries are IN-SCOPE. When a user asks about their order, do NOT refuse — call the get_user_orders tool. If the tool returns "not signed in", tell the user to sign in to view their orders.

LANGUAGE: Reply in the same language as the user's message. Support English, বাংলা (Bengali Unicode), and Banglish (Bengali written in Latin script). If the user mixes languages, mirror their mix.

TOOLS (v3.0 — Phase 3):
You have access to function-calling tools that let you query the TreeFriend database:
- search_catalog(query, max_price?, sunlight?) — search products with optional filters
- get_product_care(product_slug) — get detailed care info for a specific product
- get_user_orders() — get the signed-in user's recent orders (requires sign-in)
- get_order_details(order_number) — get detailed status for a specific order
- search_knowledge_base(query, category_slug?, product_slug?, max_results?) — search curated plant care content from creators

USE TOOLS when:
- The user asks about specific products → call search_catalog first, then get_product_care if they want details
- The user asks "where is my order" or "what did I buy" → call get_user_orders
- The user mentions a specific order number → call get_order_details
- The user asks a specific botanical question and no KNOWLEDGE BASE CONTEXT was injected → call search_knowledge_base

If a tool returns "not signed in", tell the user to sign in to access that feature.
Don't call tools unnecessarily — if the CATALOG CONTEXT already has the answer, use it.

RULES:
- Never invent product prices, IDs, slugs, or availability you didn't see in the CATALOG CONTEXT or tool results.
- If a tree is in the catalog, mention its EXACT name wrapped in double square brackets like [[Alphonso Mango]] or [[Mango Sapling]] — the frontend will auto-link these to the product page. Use the exact name as it appears in the CATALOG CONTEXT or tool results.
- If a tree is NOT in the catalog, answer from general botanical knowledge — don't wrap it in brackets and don't claim it's for sale.
- Be concise: 2-4 short paragraphs max. Use short sentences.
- Use Markdown for formatting: **bold** for key terms, bullet lists (- item) for care instructions, line breaks (double newline) between sections.
- Don't be sycophantic ("Great question!"). Just answer.
- v3.0: If a PRIOR CONVERSATION SUMMARY block is present, use it for long-term context. Don't re-ask questions the summary already answers (e.g. if the summary says the user has a balcony garden, don't ask about their setup again).

KNOWLEDGE BASE (v3.0 — Phase 3):
When a KNOWLEDGE BASE CONTEXT block is present, use it as your PRIMARY source for factual information. The KB contains vetted content from plant care experts and content creators — it's more accurate and up-to-date than your training data.

Rules for KB usage:
- If the KB context answers the user's question, use the KB content and cite the creator (e.g. "According to Green Garden BD's YouTube video...").
- If the KB context partially answers the question, use what's relevant + supplement with your training data for missing details.
- If the KB context doesn't answer the question, fall back to your training data (no citation needed).
- Always call the search_knowledge_base tool if the user asks a specific botanical question and no KB context was injected. The tool returns more detailed results than the pre-injected context.
- NEVER invent content that isn't in the KB or your training data. If you don't know, say so.

FORMATTING — STRICTLY FOLLOW:
After your main answer, ALWAYS append a follow-up suggestions block in this EXACT format (the frontend parses it to render clickable chips):

[followups]
- First short question the user might ask next
- Second short question
- Third short question
[/followups]

The questions should be relevant to the user's current question and your answer. Each on its own line, prefixed with "- ". Keep them short (max 8 words each). Write them in the SAME language as your main answer.{{summary}}{{knowledge}}{{catalog}}

REMEMBER: Stay strictly on-topic. If you're unsure whether a question is botanical, refuse politely. Always include the [followups]...[/followups] block at the end.`;

/**
 * Renders a prompt template by replacing `{{summary}}`, `{{knowledge}}`,
 * and `{{catalog}}` placeholders with the dynamic values.
 *
 * Placeholder order in the template: `{{summary}}{{knowledge}}{{catalog}}`
 * (knowledge is BEFORE catalog so the AI sees KB context first — higher
 * priority than product listings).
 *
 * If a placeholder is missing from the template, the dynamic value is
 * appended in the right position (backward compat with prompts that
 * don't include the placeholders — they still get the context, just at
 * the end). The knowledge block (if non-empty) is inserted BEFORE the
 * catalog block in the fallback path.
 *
 * This is the single source of truth for placeholder substitution.
 * Both the DB-driven path (route uses active prompt text from DB) and
 * the fallback path (route uses SYSTEM_PROMPT_TEMPLATE_V1) go through
 * this function, ensuring consistent behavior.
 *
 * @param template The prompt text with optional `{{summary}}`/`{{knowledge}}`/`{{catalog}}` placeholders.
 * @param summaryBlock The conversation summary block (or "" if no summary).
 * @param catalogContext The catalog search results (or "" if no matches).
 * @param knowledgeBlock The KB context block (or "" if no high-confidence KB matches).
 */
export function renderPromptTemplate(
  template: string,
  summaryBlock: string,
  catalogContext: string,
  knowledgeBlock: string = "",
): string {
  const contextBlock = catalogContext
    ? `\n\nCATALOG CONTEXT (use when relevant; cite exact product names):\n${catalogContext}\n`
    : `\n\nCATALOG CONTEXT: (no matching products or articles found for this query)\n`;

  const summary = summaryBlock || "";
  const knowledge = knowledgeBlock || "";

  let rendered = template;

  // Replace {{summary}} placeholder if present.
  if (rendered.includes("{{summary}}")) {
    rendered = rendered.replaceAll("{{summary}}", summary);
  } else if (summary) {
    // No placeholder but summary exists — append at the end (backward compat).
    rendered = rendered + "\n" + summary;
  }

  // Replace {{knowledge}} placeholder if present.
  if (rendered.includes("{{knowledge}}")) {
    rendered = rendered.replaceAll("{{knowledge}}", knowledge);
  } else if (knowledge) {
    // No placeholder but knowledge exists — insert before the catalog
    // block (so KB context appears first = higher priority). We find the
    // catalog block + prepend the knowledge block to it.
    rendered = rendered.replace(
      /(\n\nCATALOG CONTEXT)/,
      `\n\n${knowledge}$1`,
    );
  }

  // Replace {{catalog}} placeholder if present.
  if (rendered.includes("{{catalog}}")) {
    rendered = rendered.replaceAll("{{catalog}}", contextBlock);
  } else {
    // No placeholder — append at the end (backward compat).
    rendered = rendered + contextBlock;
  }

  return rendered;
}

/**
 * Builds the system prompt using the HARDCODED fallback template
 * (SYSTEM_PROMPT_TEMPLATE_V1).
 *
 * ─── Bug #3 fix: this is now the FALLBACK only ─────────────────────────────
 *
 * The PRIMARY path is the DB-driven prompt (via `getActivePrompt()` in
 * `lib/promptVersioning.ts`). When the DB has an active prompt, the route
 * uses its `prompt_text` (rendered via `renderPromptTemplate`). When the
 * DB is unavailable or has no active row, the route falls back to this
 * function — which calls `renderPromptTemplate` with the hardcoded
 * template, producing identical output.
 *
 * This function is kept public for:
 *   - Tests that need a deterministic prompt without DB access.
 *   - The seed migration in ensureAiTables.ts (which stores this text in
 *     the DB so the DB-driven path produces the same output).
 *   - Future code that needs to build a prompt without the versioning
 *     system (e.g. a one-off script).
 */
export function buildSystemPrompt(
  catalogContext: string,
  summaryBlock: string = "",
  knowledgeBlock: string = "",
): string {
  return renderPromptTemplate(SYSTEM_PROMPT_TEMPLATE_V1, summaryBlock, catalogContext, knowledgeBlock);
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface ProductRow {
  name: string;
  slug: string;
  scientific_name: string | null;
  description: string | null;
  sunlight: string | null;
  watering: string | null;
  soil_type: string | null;
  mature_height: string | null;
  product_status: string | null;
}

interface BlogRow {
  title: string;
  slug: string;
  excerpt: string | null;
  content: string | null;
}

function extractSearchTokens(message: string): string[] {
  // Split on whitespace + punctuation, keep tokens >=3 chars, drop pure
  // numbers and stop words. Cap at 5 tokens to keep the SQL reasonable.
  const STOP = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "i",
    "you",
    "he",
    "she",
    "it",
    "we",
    "they",
    "this",
    "that",
    "these",
    "those",
    "what",
    "which",
    "who",
    "when",
    "where",
    "why",
    "how",
    "for",
    "in",
    "on",
    "at",
    "to",
    "of",
    "with",
    "from",
    "by",
    "my",
    "me",
    "please",
    "tell",
    "give",
    "want",
    "need",
    "about",
  ]);

  const tokens = (message.toLowerCase().match(/[a-z\u0980-\u09ff]{3,}/gi) ?? []).filter(
    (t) => !STOP.has(t) && !/^\d+$/.test(t),
  );

  // Dedupe + cap
  return Array.from(new Set(tokens)).slice(0, 5);
}

async function searchProducts(tokens: string[]): Promise<ProductRow[]> {
  if (tokens.length === 0) return [];
  // Build a single OR ILIKE clause: (name ILIKE '%t1%' OR scientific_name ILIKE '%t1%' OR ...)
  // Same tokens searched across name + scientific_name + description.
  //
  // Schema: products uses `deleted_at TIMESTAMP` (null = live), not a
  // boolean `is_deleted` column. Filter: deleted_at IS NULL.
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    conditions.push(`name ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`scientific_name ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`description ILIKE $${params.length}`);
  }
  const where = conditions.join(" OR ");
  // Add one more param for the name-priority sort tie-breaker.
  params.push(`%${tokens[0]}%`);
  const namePriorityParam = `$${params.length}`;

  try {
    // Primary path: respect the soft-delete column (deleted_at IS NULL).
    const result = await pool.query(
      `SELECT name, slug, scientific_name, description, sunlight, watering,
              soil_type, mature_height, product_status
       FROM products
       WHERE deleted_at IS NULL AND (${where})
       ORDER BY
         CASE WHEN name ILIKE ${namePriorityParam} THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT ${MAX_PRODUCTS}`,
      params,
    );
    const rows = result.rows as ProductRow[];

    // v3.0: If ILIKE found nothing, try pg_trgm fuzzy search as a fallback.
    // This catches typos ("mangoo" -> "mango") and fuzzy descriptors
    // ("drought-resistant plant") that ILIKE misses.
    if (rows.length === 0) {
      return await searchProductsTrigram(tokens);
    }

    return rows;
  } catch {
    // Fallback: older DBs may not have the deleted_at column yet (e.g. if
    // migrations were only partially applied). Drop the soft-delete filter.
    const result = await pool.query(
      `SELECT name, slug, scientific_name, description, sunlight, watering,
              soil_type, mature_height, product_status
       FROM products
       WHERE (${where})
       ORDER BY created_at DESC
       LIMIT ${MAX_PRODUCTS}`,
      params.slice(0, params.length - 1), // drop the name-priority param
    );
    return result.rows as ProductRow[];
  }
}

/**
 * v3.0: pg_trgm fuzzy search fallback.
 *
 * Called when ILIKE returns zero results. Uses PostgreSQL's pg_trgm
 * extension to compute trigram similarity between the query tokens and
 * the product name/description. Returns products with similarity > 0.3
 * (configurable via AI_TRIGRAM_THRESHOLD env var), sorted by similarity.
 *
 * Requires the pg_trgm extension + GIN indexes (created by ensureAiTables.ts).
 * If the extension isn't available, this function returns [] (the caller
 * already has the empty ILIKE result, so the user just gets no catalog
 * context -- the model falls back to general botanical knowledge).
 */
async function searchProductsTrigram(tokens: string[]): Promise<ProductRow[]> {
  if (tokens.length === 0) return [];

  // Combine tokens into a single query string for trigram matching.
  // pg_trgm's similarity() function works best on multi-word strings.
  const queryString = tokens.join(" ");
  const threshold = Number(process.env.AI_TRIGRAM_THRESHOLD ?? 0.3);

  try {
    const result = await pool.query(
      `SELECT name, slug, scientific_name, description, sunlight, watering,
              soil_type, mature_height, product_status
       FROM products
       WHERE deleted_at IS NULL
         AND (
           similarity(name, $1) > $2
           OR similarity(COALESCE(scientific_name, ''), $1) > $2
           OR similarity(COALESCE(description, ''), $1) > $2
         )
       ORDER BY
         GREATEST(
           similarity(name, $1),
           similarity(COALESCE(scientific_name, ''), $1),
           similarity(COALESCE(description, ''), $1)
         ) DESC
       LIMIT ${MAX_PRODUCTS}`,
      [queryString, threshold],
    );

    const rows = result.rows as ProductRow[];
    if (rows.length > 0) {
      logger.debug(
        { tokens, queryString, count: rows.length },
        "AI context: trigram fallback found results where ILIKE found none",
      );
    }
    return rows;
  } catch (err) {
    // pg_trgm extension not available, or GIN indexes missing. Silent
    // fallback -- the user just gets no catalog context for this query.
    logger.debug({ err, tokens }, "AI context: trigram search unavailable (extension missing?)");
    return [];
  }
}

async function searchBlogPosts(tokens: string[]): Promise<BlogRow[]> {
  if (tokens.length === 0) return [];
  // Schema: blog_posts has `content` (not `body`) and `published_at`
  // (null = draft). No `is_published` boolean column — filter on
  // published_at IS NOT NULL for "live" posts.
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    conditions.push(`title ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`excerpt ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`content ILIKE $${params.length}`);
  }
  const where = conditions.join(" OR ");

  try {
    const result = await pool.query(
      `SELECT title, slug, excerpt, content
       FROM blog_posts
       WHERE published_at IS NOT NULL AND (${where})
       ORDER BY published_at DESC NULLS LAST, created_at DESC
       LIMIT ${MAX_BLOG_POSTS}`,
      params,
    );
    return result.rows as BlogRow[];
  } catch {
    // Fallback: if published_at column doesn't exist (very old DB), just
    // return all matches. Better to have context than none.
    const result = await pool.query(
      `SELECT title, slug, excerpt, content
       FROM blog_posts
       WHERE (${where})
       ORDER BY created_at DESC
       LIMIT ${MAX_BLOG_POSTS}`,
      params,
    );
    return result.rows as BlogRow[];
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
