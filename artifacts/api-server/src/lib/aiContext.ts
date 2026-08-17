/**
 * Catalog context builder for the TreeBot assistant.
 *
 * The job of this module is to make the AI "aware" of what's in the
 * TreeFriend database WITHOUT exposing the database directly to the model.
 *
 * Pattern (v3.7: Hybrid ILIKE + per-token pg_trgm similarity in a single query):
 *   1. Take the user's message.
 *   2. Pull keywords from it.
 *   3. Query `products` with a hybrid WHERE clause:
 *        (name/sci_name/description ILIKE '%t%')              -- exact substring
 *        OR (GREATEST(similarity(col, $t1), ...) > threshold) -- fuzzy trigram
 *      sorted by a relevance score that boosts exact name ILIKE hits
 *      over fuzzy description hits. See `searchProducts()` for details.
 *   4. ILIKE-search `blog_posts` (title, body) for those keywords.
 *   5. Inject the top results into the system prompt as plain text.
 *
 * Why hybrid (not pure-trigram, not ILIKE-then-trigram-fallback)?
 *   - Typical marketplace catalogs have hundreds to low thousands of SKUs.
 *     The hybrid query catches BOTH exact substrings ("mango_tree_seedling")
 *     AND typos ("mangoo") in a single round-trip, sorted by relevance.
 *   - The old v3.0 two-step pattern (ILIKE first, trigram only if zero
 *     results) hid trigram matches whenever ANY ILIKE match existed — even
 *     unrelated ones — making typo-tolerance unreliable.
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
  // Bangla (Unicode) — v5.3: expanded common plant names + care terms.
  // The keyword list is now a FAST-PATH optimization (not a hard gate).
  // If a message fails this check, the LLM topic classifier runs as fallback.
  // So this list doesn't need to be exhaustive — just common enough to
  // skip the LLM call for ~70-80% of messages.
  "গাছ",
  "গাছের",
  "গাছে",
  "চারা",
  "চারার",
  "বীজ",
  "বীজের",
  "মাটি",
  "মাটির",
  "পানি",
  "পানির",
  "রোদ",
  "রোদে",
  "ছায়া",
  "ছায়ায়",
  "সার",
  "সারের",
  "ফুল",
  "ফুলের",
  "পাতা",
  "পাতার",
  "ফল",
  "ফলের",
  "বাগান",
  "বাগানে",
  "বাগানের",
  "শিকড",
  "শিকড়",
  "ডাল",
  "ডালের",
  "গোলাপ",
  "বনসাই",
  // v5.3: common plant names (Bengali)
  "কলা",
  "কলার",
  "আম",
  "আমের",
  "নারকেল",
  "নারকেলের",
  "কাঁঠাল",
  "কাঁঠালের",
  "লিচু",
  "লিচুর",
  "পেঁপে",
  "পেঁপের",
  "লেবু",
  "লেবুর",
  "পেয়ারা",
  "পেয়ারার",
  "তাল",
  "তালের",
  "সুপারি",
  "বরই",
  "জাম",
  "আতা",
  "সফেদা",
  "বেল",
  "আমলকী",
  // v5.3: common question/care terms (Bengali)
  "জাত",
  "জাতের",
  "ভালো",
  "কিভাবে",
  "কেমন",
  "কখন",
  "কোথায়",
  "কত",
  "পরিচর্যা",
  "যত্ন",
  "লাগানো",
  "লাগান",
  "রোপণ",
  "চাষ",
  "ফসল",
  "উৎপাদন",
  "রোগ",
  "পোকা",
  "মাজরা",
  "পাতা পোড়া",
  "হলুদ পাতা",
  // v5.3: additional gardening terms
  "বীজতলা",
  "কলম",
  "কলম করা",
  "ছাটাই",
  "ছেঁটে",
  "পুনর্বাসন",
  "রিপট",
  "প্রতিস্থাপন",
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
/**
 * v6.1 (Part 2): the intent classifier (lib/intentClassifier.ts) returns
 * "PURCHASE" | "KNOWLEDGE" | "MIXED" | "GREETING" for each user message.
 *
 * When the intent is PURCHASE, the AI will call the new search_seller_listings
 * tool (Part 2) which returns specific purchasable listings. There's no
 * point ALSO injecting the variety-level CATALOG CONTEXT — it would:
 *   - Waste tokens (~200-500 per request) on variety info the AI doesn't need.
 *   - Confuse the LLM by mixing two different granularities of info.
 *   - Risk the LLM citing variety names ([[Alphonso Mango]]) instead of
 *     specific listings ([[listing:42|...]]).
 *
 * So when intent === "PURCHASE", we SKIP the catalog context block. The
 * search_seller_listings tool result is the authoritative source for
 * purchase-intent responses.
 *
 * For KNOWLEDGE + MIXED + GREETING intent, we keep the existing behavior
 * (inject the catalog context). MIXED intent benefits from BOTH (the
 * variety info helps with the knowledge half, the listing tool handles
 * the purchase half).
 */
export async function buildCatalogContext(
  userMessage: string,
  intent?: "PURCHASE" | "KNOWLEDGE" | "MIXED" | "GREETING" | null,
): Promise<string> {
  // v6.1: skip catalog context for pure PURCHASE intent — the AI will call
  // search_seller_listings instead, which returns specific listings.
  if (intent === "PURCHASE") {
    return "";
  }

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

TOOLS (v3.0 — Phase 3, v6.1 — seller-listing search):
You have access to function-calling tools that let you query the TreeFriend database:
- search_catalog(query, max_price?, sunlight?) — search the VARIETY catalog (admin-owned product info). Returns variety-level data (name, slug, sunlight, watering) + an aggregate min_price across sellers. Use this for KNOWLEDGE-intent questions about what varieties exist.
- get_product_care(product_slug) — get detailed care info for a specific variety. Use this for KNOWLEDGE-intent questions about how to care for a plant.
- search_seller_listings(query, max_price?, form?, limit?) — search ACTUAL purchasable seller listings (v6.1). Returns specific listings with seller name, location, variants (form, height, price, stock), rating, delivery info. Use this for PURCHASE-intent questions — when the user wants to BUY something.
- get_user_orders() — get the signed-in user's recent orders (requires sign-in)
- get_order_details(order_number) — get detailed status for a specific order
- search_knowledge_base(query, category_slug?, product_slug?, max_results?) — search curated plant care content from creators

USE TOOLS when:
- The user wants to BUY something ("I want a mango sapling", "where can I get", "price of", "in stock near me") → call search_seller_listings. The system automatically detects purchase intent via the new intent classifier (v6.1) and may pre-call this tool for you.
- The user asks about specific varieties (knowledge intent) → call search_catalog first, then get_product_care if they want details
- The user asks "where is my order" or "what did I buy" → call get_user_orders
- The user mentions a specific order number → call get_order_details
- The user asks a specific botanical question and no KNOWLEDGE BASE CONTEXT was injected → call search_knowledge_base

If a tool returns "not signed in", tell the user to sign in to access that feature.
Don't call tools unnecessarily — if the CATALOG CONTEXT already has the answer, use it.

RULES:
- Never invent product prices, IDs, slugs, or availability you didn't see in the CATALOG CONTEXT or tool results.
- v6.1 DUAL-CITATION FORMAT — use the right format based on intent:
  - For KNOWLEDGE answers (variety info, care, botanical facts), wrap the EXACT variety name in double square brackets like [[Alphonso Mango]] — the frontend linkifies these to the variety catalog search page (/products?q=<name>).
  - For PURCHASE answers (specific seller listings), wrap each listing you recommend in the NEW format: [[listing:<id>|<display>]] where <id> is the listingId from the search_seller_listings tool result, and <display> is a short human-readable label (e.g. [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]). The frontend deep-links these to the SellerListingDetailPage (/products/:productId/listings/:listingId) — one click to buy.
  - Use ONLY ONE format per listing — don't double-cite. If you mention a variety by name, use [[name]]. If you mention a specific purchasable listing, use [[listing:id|display]].
- If a tree is NOT in the catalog, answer from general botanical knowledge — don't wrap it in brackets and don't claim it's for sale.
- Be concise: 2-4 short paragraphs max. Use short sentences.
- Use Markdown for formatting: **bold** for key terms, bullet lists (- item) for care instructions, line breaks (double newline) between sections.
- Don't be sycophantic ("Great question!"). Just answer.
- v3.0: If a PRIOR CONVERSATION SUMMARY block is present, use it for long-term context. Don't re-ask questions the summary already answers (e.g. if the summary says the user has a balcony garden, don't ask about their setup again).

KNOWLEDGE BASE (v3.0 — Phase 3):
When a KNOWLEDGE BASE CONTEXT block is present, use it as your PRIMARY source for factual information. The KB contains vetted content from plant care experts and content creators — it's more accurate and up-to-date than your training data.

Rules for KB usage:
- If the KB context answers the user's question, use the KB content as authoritative plant-care advice. Do not attribute it to any specific person or source.
- If the KB context partially answers the question, use what's relevant + supplement with your training data for missing details.
- If the KB context doesn't answer the question, fall back to your training data.
- Always call the search_knowledge_base tool if the user asks a specific botanical question and no KB context was injected. The tool returns more detailed results than the pre-injected context.
- NEVER invent content that isn't in the KB or your training data. If you don't know, say so.

BUG-I1 fix — UNIFIED RETRIEVAL CONTRACT:
The KNOWLEDGE BASE CONTEXT block above and the search_knowledge_base tool use the SAME retrieval parameters (minScore=0.3, reranked, 5 entries max, 500 chars per entry). If an entry appears in both, they are the same source — cite it only once. If you want more entries, call the tool with max_results=10.

FORMATTING — STRICTLY FOLLOW:
After your main answer, ALWAYS append a follow-up suggestions block in this EXACT format (the frontend parses it to render clickable chips):

[followups]
- First short question the user might ask next
- Second short question
- Third short question
[/followups]

The questions should be relevant to the user's current question and your answer. Each on its own line, prefixed with "- ". Keep them short (max 8 words each). Write them in the SAME language as your main answer.{{summary}}{{knowledge}}{{listings}}{{catalog}}{{tone}}

REMEMBER: Stay strictly on-topic. If you're unsure whether a question is botanical, refuse politely. Always include the [followups]...[/followups] block at the end.`;

/**
 * Renders a prompt template by replacing `{{summary}}`, `{{knowledge}}`,
 * `{{catalog}}`, and `{{tone}}` placeholders with the dynamic values.
 *
 * Placeholder order in the template: `{{summary}}{{knowledge}}{{catalog}}{{tone}}`
 * (tone is LAST — the AI sees content first, then tone guidance as the
 * final instruction before generating).
 *
 * If a placeholder is missing from the template, the dynamic value is
 * appended in the right position (backward compat with prompts that
 * don't include the placeholders — they still get the context, just at
 * the end). The tone block (if non-empty) is appended after the catalog
 * block in the fallback path.
 *
 * This is the single source of truth for placeholder substitution.
 * Both the DB-driven path (route uses active prompt text from DB) and
 * the fallback path (route uses SYSTEM_PROMPT_TEMPLATE_V1) go through
 * this function, ensuring consistent behavior.
 *
 * @param template The prompt text with optional `{{summary}}`/`{{knowledge}}`/`{{catalog}}`/`{{tone}}` placeholders.
 * @param summaryBlock The conversation summary block (or "" if no summary).
 * @param catalogContext The catalog search results (or "" if no matches).
 * @param knowledgeBlock The KB context block (or "" if no high-confidence KB matches).
 * @param toneBlock The tone matching block (or "" if no tone matching).
 */
export function renderPromptTemplate(
  template: string,
  summaryBlock: string,
  catalogContext: string,
  knowledgeBlock: string = "",
  toneBlock: string = "",
  /**
   * v6.1 Part 3: seller-listing context block. Auto-injected when the
   * intent classifier detects PURCHASE or MIXED intent — the chat route
   * pre-calls search_seller_listings so the LLM has the listings upfront
   * (mirrors how getTopKbEntriesForPrompt auto-injects KB context).
   */
  listingsBlock: string = "",
): string {
  const contextBlock = catalogContext
    ? `\n\nCATALOG CONTEXT (use when relevant; cite exact product names):\n${catalogContext}\n`
    : `\n\nCATALOG CONTEXT: (no matching products or articles found for this query)\n`;

  const summary = summaryBlock || "";
  const knowledge = knowledgeBlock || "";
  const tone = toneBlock || "";
  const listings = listingsBlock || "";

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
    rendered = rendered.replace(/(\n\nCATALOG CONTEXT)/, `\n\n${knowledge}$1`);
  }

  // v6.1 Part 3: Replace {{listings}} placeholder if present.
  // The listings block is the auto-injected seller-listing context for
  // PURCHASE-intent queries. Distinct from {{knowledge}} (KB care info)
  // — different semantic meaning, different citation format.
  if (rendered.includes("{{listings}}")) {
    rendered = rendered.replaceAll("{{listings}}", listings);
  } else if (listings) {
    // No placeholder but listings exist — insert before the catalog block
    // (same priority logic as knowledge — listings context is more
    // actionable than variety-level catalog info for purchase queries).
    rendered = rendered.replace(/(\n\nCATALOG CONTEXT)/, `\n\n${listings}$1`);
  }

  // Replace {{catalog}} placeholder if present.
  if (rendered.includes("{{catalog}}")) {
    rendered = rendered.replaceAll("{{catalog}}", contextBlock);
  } else {
    // No placeholder — append at the end (backward compat).
    rendered = rendered + contextBlock;
  }

  // Replace {{tone}} placeholder if present.
  // Phase 4: tone is the last instruction — appended after catalog.
  if (rendered.includes("{{tone}}")) {
    rendered = rendered.replaceAll("{{tone}}", tone);
  } else if (tone) {
    // No placeholder but tone exists — append at the end.
    rendered = rendered + "\n" + tone;
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
  toneBlock: string = "",
  listingsBlock: string = "",
): string {
  return renderPromptTemplate(
    SYSTEM_PROMPT_TEMPLATE_V1,
    summaryBlock,
    catalogContext,
    knowledgeBlock,
    toneBlock,
    listingsBlock,
  );
}

// ─── v6.1 Part 3: format seller-listing context for the system prompt ───────

/**
 * Formats seller-listing search results as a system prompt block.
 *
 * The block is injected into the {{listings}} placeholder (or appended
 * before the catalog block if the placeholder is missing). It tells the
 * LLM to use these listings as the primary source for purchase-intent
 * responses, and to cite each listing using the new
 * [[listing:<id>|<display>]] format.
 *
 * Industry standard: same pattern as formatKbContextForPrompt — a clear
 * header explaining the block's purpose + structured entries the LLM can
 * reference. The block explicitly tells the LLM the citation format +
 * that clicking the chip deep-links to the SellerListingDetailPage.
 *
 * Token budget: each listing is ~80-120 tokens (id, seller name, location,
 * 2-3 variants with form/price/stock). 5 listings = ~500-600 tokens.
 * Within Gemini/Groq context windows (128K+).
 *
 * @param listings The listings returned by searchSellerListings.
 * @returns A formatted prompt block, or "" if no listings.
 */
export function formatSellerListingContextForPrompt(
  listings: {
    listingId: number;
    productId: number;
    productName: string;
    sellerName: string;
    sellerLocation: string | null;
    sellerIsVerified: boolean;
    rating: number;
    reviewCount: number;
    deliveryTimeDays: number | null;
    minPrice: number | null;
    hasInStockVariant: boolean;
    hasPreOrderVariant: boolean;
    variants: {
      form: string | null;
      height: string | null;
      price: number;
      discountPrice: number | null;
      availableQuantity: number;
      isPreOrder: boolean;
    }[];
  }[],
): string {
  if (!listings || listings.length === 0) return "";

  const lines: string[] = [
    "SELLER LISTING CONTEXT (use as PRIMARY source for purchase-intent responses):",
    "For each listing you recommend, cite it using the format [[listing:<id>|<display>]] where <id> is the listingId and <display> is a short label (e.g. [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]). The frontend will deep-link this to the SellerListingDetailPage where the user can add to cart.",
    "",
  ];

  for (const l of listings) {
    const inStockLabel = l.hasInStockVariant
      ? l.hasPreOrderVariant
        ? "in stock + pre-order"
        : "in stock"
      : l.hasPreOrderVariant
        ? "pre-order only"
        : "out of stock";

    const verifiedLabel = l.sellerIsVerified ? " [verified seller]" : "";
    const ratingLabel =
      l.reviewCount > 0 ? ` ${l.rating.toFixed(1)}★ (${l.reviewCount} reviews)` : " no reviews";

    lines.push(
      `- listingId:${l.listingId} productId:${l.productId} "${l.productName}" — seller: ${l.sellerName}${verifiedLabel}, location: ${l.sellerLocation ?? "unknown"}, ${inStockLabel}${ratingLabel}, minPrice: ${l.minPrice ?? "n/a"} BDT${l.deliveryTimeDays !== null ? `, delivery: ${l.deliveryTimeDays}d` : ""}`,
    );

    // List up to 3 variants per listing.
    for (const v of l.variants.slice(0, 3)) {
      const formPart = v.form ? `${v.form}` : "variant";
      const heightPart = v.height ? `, ${v.height}` : "";
      const effectivePrice = v.discountPrice ?? v.price;
      const stockPart =
        v.availableQuantity > 0
          ? `${v.availableQuantity} in stock`
          : v.isPreOrder
            ? "pre-order"
            : "out of stock";
      lines.push(`    - variant: ${formPart}${heightPart}, ${effectivePrice} BDT, ${stockPart}`);
    }
  }

  return lines.join("\n");
}

// ─── BUG-I5 fix: clear the KB block after the first tool round ──────────────

/**
 * Clears the KNOWLEDGE BASE CONTEXT block from a rendered system prompt,
 * replacing it with a brief marker.
 *
 * The KB block is added by `formatKbContextForPrompt()` and looks like:
 *
 *   KNOWLEDGE BASE CONTEXT (use as PRIMARY source — cite the creator):
 *   - "Title" (Creator — source)
 *     Content...
 *   - "Title 2" ...
 *
 * After the LLM calls `search_knowledge_base`, the tool results are the
 * primary source — keeping the auto-inject block around would create
 * confusion (stale context mixed with fresh tool results). This is the
 * Anthropic Contextual Retrieval anti-pattern: "stale auto-inject
 * context mixed with fresh tool results".
 *
 * This function finds the block (delimited by the header line) and
 * replaces it with:
 *
 *   KNOWLEDGE BASE CONTEXT: (cleared — see search_knowledge_base tool
 *   results above for the current KB context)
 *
 * The TONE MATCHING block is NOT touched — tone persists across tool
 * rounds (the tone-locked creator doesn't change mid-request). The LLM
 * should still apply the tone-locked creator's style to its response,
 * but for tool-returned entries from a different creator, it should use
 * neutral tone (per BUG-I4 fix).
 *
 * @param systemPrompt - the rendered system prompt
 * @returns the system prompt with the KB block cleared (or unchanged if
 *          no KB block was present)
 */
export function clearKbBlockFromPrompt(systemPrompt: string): string {
  // The exact header emitted by formatKbContextForPrompt in kbSearch.ts.
  // Privacy: header no longer says "cite the creator" (creator names are
  // not surfaced to the LLM). The regex matches both the old header (for
  // backward-compat with cached prompts) and the new one.
  const HEADER_PATTERN =
    /KNOWLEDGE BASE CONTEXT \(use as PRIMARY source(?: — cite the creator)?\):/;
  const REPLACEMENT =
    "KNOWLEDGE BASE CONTEXT: (cleared — see search_knowledge_base tool " +
    "results above for the current KB context)";

  const match = HEADER_PATTERN.exec(systemPrompt);
  if (!match) return systemPrompt; // no KB block present, nothing to clear

  const headerEnd = match.index + match[0].length;
  const restOfPrompt = systemPrompt.slice(headerEnd);

  // The KB block ends at the next known section header. The rendered
  // prompt's structure (post-placeholder-substitution) is:
  //
  //   ... main template ...
  //   {{summary}} (if any) — PRIOR CONVERSATION SUMMARY block
  //   {{knowledge}} — KNOWLEDGE BASE CONTEXT block (THIS is what we clear)
  //   {{catalog}} — CATALOG CONTEXT block
  //   {{tone}} — TONE MATCHING block (if any)
  //   ... REMEMBER: ... (final template tail)
  //
  // The KB block ends when we hit one of: CATALOG CONTEXT, TONE MATCHING,
  // PRIOR CONVERSATION SUMMARY, FORMATTING, REMEMBER, or the end of the
  // prompt. We match `\n\n` before the section name to ensure we're at
  // a section boundary (not a mid-paragraph mention).
  const NEXT_SECTION_PATTERN =
    /\n\n(CATALOG CONTEXT|TONE MATCHING|PRIOR CONVERSATION SUMMARY|FORMATTING|REMEMBER|AVAILABLE TOOLS|FOLLOWUP|YOU MUST|BUG-I1)/;
  const nextSectionMatch = NEXT_SECTION_PATTERN.exec(restOfPrompt);

  let blockEnd: number;
  if (nextSectionMatch) {
    blockEnd = headerEnd + nextSectionMatch.index;
  } else {
    // No next section found — the KB block is the last block. Clear to
    // the end of the prompt.
    blockEnd = systemPrompt.length;
  }

  return systemPrompt.slice(0, match.index) + REPLACEMENT + systemPrompt.slice(blockEnd);
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

  // v3.10: Industry-standard hybrid search — tsvector (stemming) PRIMARY,
  // trigram (typo tolerance) FALLBACK.
  //
  //   PRIMARY:   websearch_to_tsquery('english', $q) @@ search_tsvector
  //              ranked by ts_rank_cd (cover density)
  //   FALLBACK:  GREATEST(similarity(col, $t1), ...) > threshold
  //              for typo-tolerance ("mangoo" → "mango")
  //
  // Why tsvector PRIMARY (not ILIKE, not pure trigram)?
  //   - Stemming: "watering" → "water", "mangoes" → "mango", "growing" →
  //     "grow". Neither ILIKE nor trigram does this — only the Snowball
  //     stemmer in to_tsvector('english', ...).
  //   - Performance: GIN index on search_tsvector → sub-millisecond on
  //     100K+ rows. ILIKE '%term%' is a seq scan.
  //   - Relevance: ts_rank_cd orders by cover density (how close matched
  //     lexemes are), which is more accurate than ILIKE's binary match.
  //
  // Why trigram FALLBACK (not replacement)?
  //   - Typo tolerance: "mangoo" doesn't stem to "mango" — the stemmer
  //     treats it as an unknown word. Trigram similarity catches it.
  //   - Underscored/compound names: "mango_tree_seedling" — trigram
  //     similarity may fall below threshold (length mismatch), but
  //     ILIKE catches it. So we keep ILIKE too.
  //
  // The OR in WHERE combines all three: tsvector matches OR ILIKE OR
  // trigram. ts_rank_cd ranks the tsvector matches highest; the CASE
  // + similarity() boosts add fine-grained ordering for ILIKE/trigram.
  //
  // Schema: products.search_tsvector is maintained by a trigger
  // (see ensureAiTables.ts / migration 0006). It's a weighted tsvector:
  //   setweight(name, 'A') || setweight(sci_name, 'B') || setweight(desc, 'C')
  // so name matches rank higher than description matches.
  const params: unknown[] = [];
  const tokenPlaceholders: string[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    tokenPlaceholders.push(`$${params.length}`);
  }
  // Each token placeholder is reused across name + scientific_name +
  // description (same substring, three columns). Cheaper than emitting
  // 3× params for the same string.
  const ilikeWhere = tokenPlaceholders
    .map((p) => `(name ILIKE ${p} OR scientific_name ILIKE ${p} OR description ILIKE ${p})`)
    .join(" OR ");

  // v3.7: Per-token trigram similarity. Push each token as a separate
  // param (raw token, NOT %wrapped%) and build a GREATEST() expression
  // that picks the highest similarity across all tokens.
  const trigramThreshold = Number(process.env.AI_TRIGRAM_THRESHOLD ?? 0.3);
  const trigramParamPlaceholders: string[] = [];
  for (const t of tokens) {
    params.push(t);
    trigramParamPlaceholders.push(`$${params.length}`);
  }
  params.push(trigramThreshold);
  const trigramThresholdParam = `$${params.length}`;

  // GREATEST(similarity(col, $t1), similarity(col, $t2), …) — max
  // per-token similarity. Returns 0 for tokens with no overlap, so the
  // threshold check still works correctly.
  const greatestSim = (col: string): string =>
    `GREATEST(${trigramParamPlaceholders.map((p) => `similarity(${col}, ${p})`).join(", ")})`;

  const trigramWhere = `(${greatestSim("name")} > ${trigramThresholdParam}
     OR ${greatestSim("COALESCE(scientific_name, '')")} > ${trigramThresholdParam}
     OR ${greatestSim("COALESCE(description, '')")} > ${trigramThresholdParam})`;

  // v3.10: tsvector full-text search (PRIMARY path).
  // websearch_to_tsquery handles user-style search syntax (OR, -exclude,
  // "phrases"). The query is built from tokens joined by spaces.
  const tsQuery = tokens.join(" ");
  params.push(tsQuery);
  const tsQueryParam = `$${params.length}`;
  const tsvectorWhere = `(search_tsvector @@ websearch_to_tsquery('english', ${tsQueryParam}))`;

  const firstTokenParam = tokenPlaceholders[0];

  // v3.10: ts_rank_cd for tsvector relevance (cover density — how close
  // matched lexemes are). Scaled by 1000 so it dominates the CASE/similarity
  // boosts (ts_rank_cd returns 0.0-~1.0 typically; ×1000 = 0-1000).
  // The CASE (100/80/60) + similarity boosts (max ~50) act as tie-breakers
  // for rows with no tsvector match (ILIKE/trigram only).
  const scoreExpr = `(
    ts_rank_cd(search_tsvector, websearch_to_tsquery('english', ${tsQueryParam})) * 1000
    + CASE WHEN name ILIKE ${firstTokenParam} THEN 100
         WHEN scientific_name ILIKE ${firstTokenParam} THEN 80
         WHEN description ILIKE ${firstTokenParam} THEN 60
         ELSE 0 END
    + ${greatestSim("name")} * 30
    + ${greatestSim("COALESCE(scientific_name, '')")} * 15
    + ${greatestSim("COALESCE(description, '')")} * 5
  )`;

  try {
    // Primary path: tsvector + ILIKE + trigram. Respect the soft-delete column.
    const result = await pool.query(
      `SELECT name, slug, scientific_name, description, sunlight, watering,
              soil_type, mature_height, product_status,
              ${scoreExpr} AS relevance_score
       FROM products
       WHERE deleted_at IS NULL
         AND (${tsvectorWhere} OR ${ilikeWhere} OR ${trigramWhere})
       ORDER BY relevance_score DESC, created_at DESC
       LIMIT ${MAX_PRODUCTS}`,
      params,
    );
    return result.rows as ProductRow[];
  } catch (err) {
    // tsvector column missing OR pg_trgm extension missing. Fall back to
    // ILIKE + trigram (the v3.7 behavior). Non-fatal — the user gets
    // substring + typo matches; only stemming is lost.
    logger.debug(
      { err: (err as any)?.message ?? String(err), tokens },
      "AI context: tsvector search unavailable, falling back to ILIKE + trigram",
    );
    try {
      const result = await pool.query(
        `SELECT name, slug, scientific_name, description, sunlight, watering,
                soil_type, mature_height, product_status,
                (CASE WHEN name ILIKE ${firstTokenParam} THEN 100
                      WHEN scientific_name ILIKE ${firstTokenParam} THEN 80
                      WHEN description ILIKE ${firstTokenParam} THEN 60
                      ELSE 0 END
                 + ${greatestSim("name")} * 30
                 + ${greatestSim("COALESCE(scientific_name, '')")} * 15
                 + ${greatestSim("COALESCE(description, '')")} * 5
                ) AS relevance_score
         FROM products
         WHERE deleted_at IS NULL
           AND (${ilikeWhere} OR ${trigramWhere})
         ORDER BY relevance_score DESC, created_at DESC
         LIMIT ${MAX_PRODUCTS}`,
        params,
      );
      return result.rows as ProductRow[];
    } catch {
      // Final fallback: older DBs may not have the deleted_at column or
      // pg_trgm extension. Drop both — pure ILIKE (v3.0 behavior).
      const result = await pool.query(
        `SELECT name, slug, scientific_name, description, sunlight, watering,
                soil_type, mature_height, product_status
         FROM products
         WHERE (${ilikeWhere})
         ORDER BY
           CASE WHEN name ILIKE ${firstTokenParam} THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT ${MAX_PRODUCTS}`,
        params.slice(0, tokenPlaceholders.length),
      );
      return result.rows as ProductRow[];
    }
  }
}

async function searchBlogPosts(tokens: string[]): Promise<BlogRow[]> {
  if (tokens.length === 0) return [];
  // Schema: blog_posts has `content` (not `body`) and `published_at`
  // (null = draft). No `is_published` boolean column — filter on
  // published_at IS NOT NULL for "live" posts.
  //
  // v3.10: uses search_tsvector (stemming-aware) as PRIMARY + ILIKE as
  // fallback. Same pattern as searchProducts.
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
  const ilikeWhere = conditions.join(" OR ");

  // v3.10: tsvector path.
  const tsQuery = tokens.join(" ");
  params.push(tsQuery);
  const tsQueryParam = `$${params.length}`;
  const tsvectorWhere = `(search_tsvector @@ websearch_to_tsquery('english', ${tsQueryParam}))`;

  try {
    const result = await pool.query(
      `SELECT title, slug, excerpt, content,
              ts_rank_cd(search_tsvector, websearch_to_tsquery('english', ${tsQueryParam})) AS relevance_score
       FROM blog_posts
       WHERE published_at IS NOT NULL AND (${tsvectorWhere} OR ${ilikeWhere})
       ORDER BY relevance_score DESC NULLS LAST, published_at DESC NULLS LAST, created_at DESC
       LIMIT ${MAX_BLOG_POSTS}`,
      params,
    );
    return result.rows as BlogRow[];
  } catch (err) {
    // tsvector column missing — fall back to ILIKE-only.
    logger.debug(
      { err: (err as any)?.message ?? String(err), tokens },
      "AI context: blog_posts tsvector search unavailable, falling back to ILIKE-only",
    );
    try {
      const result = await pool.query(
        `SELECT title, slug, excerpt, content
         FROM blog_posts
         WHERE published_at IS NOT NULL AND (${ilikeWhere})
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT ${MAX_BLOG_POSTS}`,
        params.slice(0, params.length - 1),
      );
      return result.rows as BlogRow[];
    } catch {
      // Fallback: if published_at column doesn't exist (very old DB), just
      // return all matches. Better to have context than none.
      const result = await pool.query(
        `SELECT title, slug, excerpt, content
         FROM blog_posts
         WHERE (${ilikeWhere})
         ORDER BY created_at DESC
         LIMIT ${MAX_BLOG_POSTS}`,
        params.slice(0, params.length - 1),
      );
      return result.rows as BlogRow[];
    }
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
