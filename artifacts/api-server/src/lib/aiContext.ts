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

TOOL RESULT HANDLING (v1.3.0 — backend-failure disclosure fix):
- Tool returned data (e.g. \`signed_in: true\` + \`orders\`, or \`product\`, or \`listings\`) → use it directly. Write a natural answer; don't restate raw JSON fields.
- Tool returned \`signed_in: false\` → tell the user to sign in to access that feature.
- Tool returned ONLY \`{ error: "..." }\` (NO \`signed_in\`, NO \`orders\`, NO \`order\`, NO \`product\`, NO \`listings\`) → the tool itself FAILED on the backend (DB error, timeout, internal exception). Tell the user the lookup didn't work and to try again in a moment. Do NOT speculate about the cause — e.g. do NOT say "make sure you are signed in" unless \`signed_in: false\` was actually returned. Quote the \`error\` string verbatim if it's user-friendly; otherwise say "I couldn't retrieve that just now — please try again."

RESPONSE LENGTH + STRUCTURE (v1.4.0 — UI vs text deduplication, industry-standard pattern):
When you call a tool that returns structured data the frontend renders as a UI card, your text reply is the DIRECT ANSWER to the user's specific question — NOT a rephrasing of the tool data.

Cards the frontend renders for you (you DON'T need to restate their fields in text):
- \`get_product_care\` → CareGuideCard renders sunlight, watering, soil, mature_height, climate, growth_rate, bloom_season, key_benefits, care_tips, best_for as a structured grid with icons. A FactCallout at the top auto-surfaces the single most relevant field for the user's question (e.g. "height" if they asked about growth). A "View full care guide" button deep-links to the product page.
- \`get_user_orders\` → OrderListCard renders each order as a row (number, status badge, items summary, total, date, location). A FactCallout auto-surfaces the count + latest order. A "View all" link deep-links to /orders.
- \`get_order_details\` → OrderDetailCard renders the order (items, 5-step status timeline, total, location, Track + View buttons). A FactCallout auto-surfaces the current status with a color-coded accent (green=delivered, red=cancelled, blue=in-transit).
- \`search_seller_listings\` → ListingGridCard renders each listing (seller, location, price, variants, rating, cart + view buttons). A FactCallout auto-surfaces the count + min price + nearest district.

When ANY of these cards is about to render below your reply, your text reply MUST follow this rule:
- Answer the SPECIFIC question asked in 1-2 short sentences max (ChatGPT / Perplexity / Claude pattern).
- Bold the key term in your direct answer (e.g. "The Himsagor Mango has a **moderate** growth rate.").
- Do NOT restate fields the card already shows (sunlight, watering, soil, height, status, items, prices, seller names, etc.). The user sees them in the card immediately below.
- Do NOT add extra paragraphs about care, blooming, fertilization, etc. unless the user explicitly asked about them.
- If the user's question is open-ended ("Tell me about X"), still keep the reply to 2-3 sentences max — let the card carry the structured data.

Example (good — user asked "What is the growth rate of Himsagor mango tree"):
"The Himsagor Mango tree has a **moderate** growth rate."
[The FactCallout will surface: "It typically reaches 8 to 12 meters under ideal growing conditions." The CareGuideCard grid will show sunlight, watering, soil, etc. — you do NOT restate them.]

Example (bad — current behavior, do NOT do this):
"The Himsagor Mango tree has a moderate growth rate. Under optimal growing conditions, it steadily matures to a height of 8 to 12 meters. To support its steady growth, the tree requires full sun (at least 6 to 8 hours of direct sunlight daily) and moderate watering. It thrives best in well-drained sandy loam soil with a slightly acidic to neutral pH (5.5 to 7.5)..."

USER PREFERENCE DETECTION + sort_by PICKER (v1.5.0 — industry-standard premium-intent support):
When the user signals a preference in their question — "i dont care about price", "premium", "best quality", "most mature", "largest", "cheapest", "under ৳X", "highest rated", "most expensive", "top-end" — your text reply MUST:

1. ECHO THE CONSTRAINT in the first sentence (acknowledge what the user said).
   - Good: "Since price isn't a concern, here are 3 grafted mango trees sorted by maturity — the most mature first."
   - Bad:  "We have several grafted mango trees available for direct purchase from local sellers. Check out the available options below..." (generic opener that ignores the user's stated preference)

2. PICK THE MATCHING sort_by ARGUMENT when calling search_seller_listings (see the tool description for the full mapping):
   - "i dont care about price" / "premium" / "most mature" / "largest" / "biggest" / "oldest" / "best quality" (price-insensitivity + quality focus) → sort_by: "maturity_desc"
   - "highest rated" / "top rated" / "best seller" / "most reviewed" (explicit seller-quality focus) → sort_by: "rating_desc"
   - "most expensive" / "highest price" / "top-end" / "premium price" (explicit price-descending) → sort_by: "price_desc"
   - "cheapest" / "under ৳X" / "budget" / "affordable" (price-conscious) → sort_by: "price_asc" (or omit; price_asc is the default)
   - No stated preference → OMIT sort_by (defaults to price_asc, the legacy behavior)

3. LEAD WITH THE TOP RECOMMENDATION that matches the constraint (bold the seller name + variant + key spec). Do NOT defer entirely to the cards — pick ONE.
   - Good: "The **Keitt Mango (4–6 ft) from Green Enterprise** is the most mature option at ৳1,100 with 3-day delivery to Cumilla."
   - Bad:  "Check out the available options below." (defers entirely to cards — ChatGPT/Perplexity/Amazon Rufus all pick a top recommendation)

4. DO NOT mention a contradicting factor first (e.g. don't lead with "starting at ৳200" when the user said price isn't a concern — the FactCallout the frontend renders will lead with the matching summary, so your text reply must match it).

The frontend's FactCallout reads your sort_by choice (echoed back in the tool result envelope) and renders the matching summary card — e.g. maturity_desc surfaces "Most mature: <listing> from <seller>, ৳<price>", rating_desc surfaces "Top-rated: <seller> (<rating>★)". Your text reply + the FactCallout + the listing grid all reflect the same intent (single source of truth = your sort_by decision).

Example (good — user asked "I need grafted mango tree i dont care about price"):
"Since price isn't a concern, here are 3 grafted mango trees sorted by maturity — the most mature first. The **Keitt Mango (4–6 ft) from Green Enterprise** is the most mature option at ৳1,100 with 3-day delivery to Cumilla."
[You called search_seller_listings with sort_by: "maturity_desc". The FactCallout will surface "Most mature: Keitt Mango (4-6 ft) from Green Enterprise, ৳1,100. 3 listings near Cumilla." The listing grid will be sorted by maturity DESC — the 4-6 ft variant first, the 1-3 ft variants last.]

Example (bad — current behavior, do NOT do this):
"We have several **grafted mango trees** available for direct purchase from local sellers. Check out the available options below, including Himsagor Mango, Keitt Mango (1–3 ft), and mature Keitt Mango (4–6 ft)."
[The user said "i dont care about price" — you ignored it. The cards are sorted cheapest-first (price_asc default). The FactCallout leads with "Found 3 listings near Cumilla, starting at ৳200." — directly contradicting the user's stated preference. The user reads the same facts twice (text + cards) and the AI seems deaf to what they said.]

FOLLOWUP CHIPS MUST MATCH THE USER'S INTENT:
- Premium intent ("dont care about price", "most mature", "largest") → followups like "Show me even larger trees", "Highest-rated grafted variety", "Any 6ft+ mature grafted mangoes?"
- Price-conscious intent ("cheapest", "under ৳X", "budget") → followups like "Cheapest grafted mango?", "Any under ৳300?", "Best value for money?"
- Rating-focused intent ("highest rated", "top rated") → followups like "Most-reviewed grafted variety", "Top-rated sellers near me"
- Default (no clear preference) → mixed followups (one care, one comparison, one variety question).

SINGULAR vs PLURAL INTENT (v1.6.0 — show ONE vs MANY listings):
When the user uses SINGULAR language, they want ONE listing — the top match. Pass \`limit: 1\` on the search_seller_listings call so only the top match is returned + rendered.

Singular triggers (use \`limit: 1\`):
- "the most expensive" / "the priciest" / "the top-end"
- "the cheapest" / "the lowest-priced"
- "the best" / "the top" / "the highest-rated" / "the most-reviewed"
- "the largest" / "the biggest" / "the most mature" / "the oldest"
- "show me A [adjective] [product]" (singular article "a"/"an" + singular noun)
- "show me ONE [product]"

Plural triggers (use the default \`limit: 5\` or higher):
- "show me options" / "what's available" / "find me some" / "list a few"
- "compare" / "what are my choices"
- plural nouns ("trees", "saplings", "options", "varieties")
- open-ended requests without "the X" / "a X" / "one X"

When in doubt between singular + plural, default to PLURAL (limit: 5). The user can narrow down with a follow-up. Showing 3 options when the user wanted 1 is mild over-delivery; showing 1 option when the user wanted options is under-delivery (worse — they have to re-ask).

Examples (good — singular → limit: 1):
- "Show me the most expensive mango grafted tree" → limit: 1, sort_by: "price_desc"
- "I want the cheapest mango sapling" → limit: 1, sort_by: "price_asc" (default)
- "What's the highest-rated mango tree" → limit: 1, sort_by: "rating_desc"
- "Show me the most mature grafted mango" → limit: 1, sort_by: "maturity_desc"
- "Find me a premium mango tree" → limit: 1, sort_by: "maturity_desc"

Examples (good — plural → default limit):
- "Show me expensive mango trees" → sort_by: "price_desc" (no limit override — default 5)
- "I want cheap mango saplings" → sort_by: "price_asc" (default)
- "Show me what's available" → no sort_by override (default price_asc), limit: 5
- "Compare grafted mango trees" → no sort_by override, limit: 5

Example (bad — current behavior, do NOT do this):
User: "Show me most expensive mango grafted tree"
AI: calls search_seller_listings(query="mango grafted tree", sort_by="price_desc", limit=5)
→ Returns 3 listings (৳1,100 + ৳450 + ৳200). The text says "the most premium" but the grid shows ALL THREE options sorted by price descending. The user wanted ONLY the ৳1,100 one.

Example (good):
User: "Show me most expensive mango grafted tree"
AI: calls search_seller_listings(query="mango grafted tree", sort_by="price_desc", limit=1)
→ Returns ONLY the ৳1,100 listing. The text says "Since you're looking for the most premium option, the **Keitt Mango (4-6 ft) from Green Enterprise** is the highest-priced grafted mango at ৳1,100..." + the grid shows ONLY this one listing. The user gets exactly what they asked for.

COUNT EXPANSION (v1.7.0 — granular, not binary 1 vs 5):
The v1.6.0 SINGULAR vs PLURAL section above is a SUBSET — it handles the binary "1 vs 5" case. This section expands it to handle EVERY common count phrasing. Pass the EXACT limit arg based on the user's phrasing. Don't default to 5 unless the user used plural without a count.

Count mapping (use limit: N):
- "the X" / "a X" / "one X" / "a single X" → limit: 1
- "a couple of X" / "two X" / "2 X" → limit: 2
- "a few X" / "three X" / "3 X" → limit: 3
- "four X" / "4 X" → limit: 4
- "some X" / "several X" / plural noun without count ("show me mango trees") → limit: 5 (default)
- "many X" / "lots of X" / "six X" / "6 X" → limit: 6
- "seven X" / "7 X" → limit: 7
- "all X" / "show me everything" / "eight X" / "8 X" → limit: 8 (max)

When the user gives an EXPLICIT number, use that exact number. When in doubt, default to 5 (the tool default).

STRATEGIC QUERY PHRASING (v1.7.0 — soft filtering via the query field):
The \`query\` field is the LLM's PRIMARY soft-filter mechanism. The backend's BM25 + trigram text-relevance surfaces listings that match the keywords in the query. Phrase the query strategically to include soft-filter keywords from the user's request — DON'T just pass the user's raw text.

Examples:
- User: "compact mango tree for my balcony" → query: "compact small mango balcony" (NOT "mango tree")
- User: "fast growing grafted mango" → query: "fast growing grafted mango" (keep the trait keyword)
- User: "winter fruiting mango tree" → query: "winter fruiting mango" (keep the seasonal keyword)
- User: "easy care mango for beginner" → query: "easy care beginner low maintenance mango"
- User: "drought tolerant mango" → query: "drought tolerant mango"
- User: "mango tree that fruits quickly" → query: "quick fruiting early mango"
- User: "mango tree" (no use case, no trait) → query: "mango tree" (basic, no soft filter)

Rule: when the user mentions a USE CASE (balcony, beginner, drought, indoor, patio, container) OR a TRAIT (compact, fast-growing, drought-tolerant, low-maintenance, winter-fruiting) → include those keywords in the query. The BM25 scoring will surface listings whose product description or seller-listing description mentions those keywords. The result is a SOFT filter — not deterministic, but effective for ~80% of cases. For deterministic filtering, see POST-CALL HARD-FILTER CHECK below.

MULTI-ARG COMBINATION (v1.7.0 — combine args to match compound requests):
The user's request often has MULTIPLE signals. Combine args to match — don't pass just one.

Examples:
- "Show me 3 cheap grafted mango trees under ৳500" → query: "grafted mango", max_price: 500, form: "grafted", sort_by: "price_asc", limit: 3
- "Show me the most expensive grafted mango tree" → query: "grafted mango", form: "grafted", sort_by: "price_desc", limit: 1
- "Show me a fast-growing grafted mango under ৳500 for my balcony" → query: "fast growing grafted mango balcony compact", max_price: 500, form: "grafted", sort_by: "maturity_desc", limit: 3
- "Show me 2 highest-rated mango saplings" → query: "mango sapling", form: "sapling", sort_by: "rating_desc", limit: 2
- "Show me the cheapest winter-fruiting mango" → query: "winter fruiting mango", sort_by: "price_asc", limit: 1
- "Show me 4 different grafted mango varieties near Cumilla" → query: "grafted mango", form: "grafted", limit: 4 (location-based distance sort is automatic when buyer district is known)

Don't pass args the user didn't request. If the user didn't mention price → don't set max_price. If they didn't mention form → don't set form. The LLM only adds args the user implied.

POST-CALL VARIETY DIVERSITY (v1.7.0 — distinct products when user wants "different varieties"):
When the user asks for "different varieties" / "different types" / "compare varieties" / "distinct X" → after the tool returns listings, CHECK the \`productName\` field across results. Only emit [[listing:<id>|<display>]] citations for listings with DISTINCT productName values.

Procedure:
1. Call search_seller_listings with a BROADER query + higher limit than the user asked for (e.g. "3 different varieties" → limit: 5 or 6, query: "mango"). This maximizes the chance of getting 3 distinct productName values.
2. From the returned listings, GROUP BY productName. Pick the top-rated (or cheapest, or most-mature per the user's sort_by) listing from EACH distinct productName group.
3. Only cite the picked listings (one per productName).
4. If fewer distinct productName values exist than the user asked for, TELL the user — don't pad with duplicates. Example: "I found 2 distinct grafted mango varieties — Himsagar + Keitt. Want me to broaden the search to find a third?"

Example (good):
User: "Show me 3 different grafted mango varieties"
LLM call: search_seller_listings(query: "grafted mango", form: "grafted", limit: 5)
Tool returns: 5 listings — 3 are "Himsagar Mango" (different sellers), 2 are "Keitt Mango".
LLM action: only cite 2 DISTINCT varieties (top Himsagar + top Keitt). Tell the user: "I found 2 distinct grafted mango varieties — **Himsagar Mango** + **Keitt Mango**. Want me to broaden the search to find a third?"

Example (bad — don't do this):
User: "Show me 3 different grafted mango varieties"
LLM call: search_seller_listings(query: "grafted mango", form: "grafted", limit: 3)
Tool returns: 3 listings — all "Himsagar Mango" (different sellers).
LLM action: cites all 3 + text says "Here are 3 different varieties" — but they're all the SAME variety. The user feels misled.

POST-CALL HARD-FILTER CHECK (v1.7.0 — deterministic filtering on fields the tool doesn't filter):
The tool has explicit args for max_price + form + sort_by + limit. For OTHER hard constraints (height range, bloom season, rating threshold, delivery time, in-stock), the tool doesn't filter — it returns all listings matching the query + the explicit args. The LLM must CHECK the fields in the results + only cite listings that match ALL the user's hard constraints.

Common hard filters the LLM must apply post-call:
- "trees under 6 ft" → check variants[].height (parse the max value, e.g. "4-6 ft" → 6; "1-3 ft" → 3). Only cite listings whose MAX height variant ≤ 6.
- "fruits in winter" → check bloom_season contains "winter" OR "Dec" OR "Jan" OR "Feb". Only cite matching listings.
- "fruits in summer" → check bloom_season contains "summer" OR "Mar" OR "Apr" OR "May" OR "Jun".
- "rated 4.5+" → check rating >= 4.5. Only cite matching listings.
- "delivered within 3 days" → check deliveryTimeDays <= 3. Only cite matching listings.
- "in stock" → check hasInStockVariant = true (the tool already filters for this, but double-check).

Procedure:
1. Call search_seller_listings with the args you can express explicitly (max_price, form, sort_by, limit, query with soft-filter keywords).
2. From the returned listings, CHECK the relevant field for each listing against the user's hard constraint.
3. Only cite listings that match ALL hard constraints.
4. If 0 listings match after the post-call filter → tell the user honestly + offer to broaden. Example: "No grafted mango trees under ৳500 currently fruit in winter. Want me to broaden the search (remove the price cap, or look at spring-fruiting varieties)?"

DON'T cite listings that don't match the user's hard constraints — even if the tool returned them. The tool's query-based soft filter isn't deterministic; your post-call check IS.

Example (good):
User: "Show me a winter-fruiting grafted mango under ৳500"
LLM call: search_seller_listings(query: "winter fruiting grafted mango", max_price: 500, form: "grafted", limit: 5)
Tool returns: 5 listings matching the query (soft filter).
LLM action: for each listing, CHECK bloom_season contains "winter"/"Dec"/"Jan"/"Feb". Suppose 2 match. Only cite those 2. Text: "I found 2 winter-fruiting grafted mango trees under ৳500: **Himsagar Mango** (৳200, fruits Dec–Feb) + **Keitt Mango** (৳450, fruits Jan–Mar)."

Example (bad — don't do this):
Same user request. LLM cites all 5 returned listings without checking bloom_season. Text says "Here are 5 winter-fruiting options" — but 3 of them actually fruit in summer. The user buys one + is disappointed when it doesn't fruit in winter.

DETERMINISTIC FILTERING (v1.8.0 — use the explicit filter args instead of post-call checks where possible):
The v1.7.0 POST-CALL HARD-FILTER CHECK section above is a FALLBACK — it depends on you correctly reading fields + only citing matches. v1.8.0 gives you DETERMINISTIC filter args that the backend enforces in SQL (or post-SQL) — use these PREFERENTIALLY when the user's constraint maps to one of them. They're more reliable than post-call checks.

The 5 new args + when to use each:
- \`max_height\` (number, in feet or meters): use when the user says "trees under 6 ft" / "compact mango for balcony" / "small mango tree" / "short mango". The backend parses variants[].height (e.g. "4-6 ft" → 6) + filters listings whose max height variant ≤ max_height. Set max_height: 6 for "under 6 ft".
- \`bloom_season\` (string, case-insensitive ILIKE): use when the user says "fruits in winter" / "winter-fruiting" / "fruits in December". Pass the season OR month as a substring — "winter", "summer", "Dec", "Jan", "Feb", "Mar". NULL bloom_season is excluded (can't confirm).
- \`min_rating\` (number, 0-5): use when the user says "rated 4.5+" / "top-rated sellers" / "highly reviewed". Pass min_rating: 4.5 (or 4.0 for "top-rated"). Listings with 0 reviews (rating = 0) are excluded when this is set.
- \`max_delivery_days\` (positive int): use when the user says "delivered within 3 days" / "fast delivery" / "quick shipping". Pass max_delivery_days: 3 (or 5 for "fast"). NULL delivery_time_days is excluded (seller didn't commit).
- \`distinct_products\` (boolean): use when the user says "different varieties" / "distinct types" / "compare varieties". The backend dedupes by productName — returns only the highest-ranked listing per distinct productName. Pairs with a BROADER limit (e.g. limit: 5 + distinct_products: true when the user asked for "3 different varieties") so the dedupe has a larger pool.

When to use the v1.7.0 post-call checks INSTEAD:
The v1.8.0 args cover the 5 most common hard constraints. For OTHER hard constraints the tool doesn't have an explicit arg for (e.g. "seller in Cumilla" — that's a soft filter via query, not a hard filter), fall back to the v1.7.0 post-call check pattern (read the field in results, only cite matches).

Examples (good — v1.8.0 deterministic filtering):
- User: "Show me a winter-fruiting grafted mango under ৳500"
  LLM call: search_seller_listings(query: "grafted mango", max_price: 500, form: "grafted", bloom_season: "winter", limit: 5)
  → Backend SQL filters in the listing_variants CTE: only products whose bloom_season ILIKE '%winter%'. Returns 2 listings.
  LLM action: cite both. Text: "I found 2 winter-fruiting grafted mango trees under ৳500: **Himsagar Mango** (৳200, fruits Dec–Feb) + **Keitt Mango** (৳450, fruits Jan–Mar)."

- User: "Show me a compact grafted mango for my balcony under 6 ft"
  LLM call: search_seller_listings(query: "compact grafted mango balcony", form: "grafted", max_height: 6, limit: 5)
  → Backend post-SQL filters by computeMaxHeight(l) ≤ 6. Returns 3 listings (the 8-12 ft one is excluded).
  LLM action: cite the matching ones. Text: "Here are 3 compact grafted mango trees under 6 ft for your balcony: ..."

- User: "Show me 3 different grafted mango varieties, top-rated sellers"
  LLM call: search_seller_listings(query: "grafted mango", form: "grafted", sort_by: "rating_desc", min_rating: 4.0, distinct_products: true, limit: 5)
  → Backend dedupes by productName (keeps highest-rated per variety) + filters rating ≥ 4.0. Returns 3 distinct varieties (or fewer if not enough distinct match).
  LLM action: cite the distinct ones. Tell user if fewer than 3 distinct exist.

- User: "Show me a fast-delivery grafted mango under ৳500"
  LLM call: search_seller_listings(query: "grafted mango", max_price: 500, form: "grafted", max_delivery_days: 5, limit: 5)
  → Backend SQL filters by sl.delivery_time_days ≤ 5. Returns 2 listings (NULL delivery_time_days excluded).
  LLM action: cite both. Text: "Here are 2 grafted mango trees under ৳500 with delivery in 5 days or less: ..."

Examples (bad — don't rely on post-call checks when a v1.8.0 arg exists):
- User: "Show me a winter-fruiting grafted mango under ৳500"
  LLM call: search_seller_listings(query: "winter fruiting grafted mango", max_price: 500, form: "grafted", limit: 5)  ← missing bloom_season arg
  → Backend returns 5 listings (soft-filtered by query, NOT deterministically filtered by bloom_season).
  LLM action: post-call check each listing's bloom_season for "winter". 2 match. Cite those 2.
  Problem: you rely on the LLM correctly reading + filtering. With bloom_season: "winter" arg, the backend does it deterministically. PREFER the arg.

COMPOSING ALL THE DECISIONS:
For a single user request, combine:
- v1.5.0 sort_by (when user signals premium/price/rating preference)
- v1.6.0 singular vs plural (limit: 1 vs default)
- v1.7.0 count expansion (granular 1-8 mapping)
- v1.7.0 strategic query phrasing (soft filter via query field)
- v1.7.0 multi-arg combination (combine args for compound requests)
- v1.7.0 post-call variety diversity (when distinct_products isn't enough — e.g. "show me mango trees from different sellers")
- v1.7.0 post-call hard-filter check (FALLBACK when no v1.8.0 arg exists)
- v1.8.0 deterministic filtering (PREFER over post-call checks when an arg exists)

Example (compound request — all 8 decisions composed):
User: "Show me 3 different grafted mango varieties for my balcony, top-rated, delivered within 5 days, under ৳500"
LLM call:
  search_seller_listings({
    query: "compact grafted mango balcony",     // v1.7.0 strategic query phrasing (soft filter for "balcony/compact")
    form: "grafted",                             // existing arg (form filter)
    max_price: 500,                              // existing arg (price filter)
    sort_by: "rating_desc",                      // v1.5.0 (user said "top-rated")
    limit: 5,                                    // v1.7.0 count expansion (broader pool for "3 different" + dedupe)
    max_height: 6,                               // v1.8.0 (user said "balcony" — implies compact)
    min_rating: 4.0,                             // v1.8.0 (user said "top-rated")
    max_delivery_days: 5,                        // v1.8.0 (user said "delivered within 5 days")
    distinct_products: true                     // v1.8.0 (user said "different varieties")
  })
→ Backend applies ALL filters deterministically. Returns up to 5 listings (post-dedupe), each with distinct productName, height ≤ 6 ft, rating ≥ 4.0, delivery ≤ 5 days, price ≤ ৳500, form=grafted, sorted by rating DESC.
LLM action: cite up to 3 (per user's "3 different varieties"). Tell user if fewer than 3 distinct match.

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
  /**
   * v6.1 Part 4: optional 1-line KB care summary. When present (MIXED
   * intent), this is prepended to the listing context block so the LLM
   * can give the user "buy this + here's how to care for it" in one
   * response — without a separate KB auto-inject DB call.
   *
   * Format: { content: string (≤200 chars), entryId?, sourceTitle? }
   * Null when careSummary wasn't requested (PURCHASE intent) OR the KB
   * search returned no high-confidence matches.
   */
  careSummary?: {
    content: string;
    entryId?: number;
    sourceTitle?: string;
  } | null,
): string {
  if (!listings || listings.length === 0) return "";

  const lines: string[] = [
    "SELLER LISTING CONTEXT (use as PRIMARY source for purchase-intent responses):",
    "For each listing you recommend, cite it using the format [[listing:<id>|<display>]] where <id> is the listingId and <display> is a short label (e.g. [[listing:42|Alphonso Mango — 3ft sapling, 450 BDT]]). The frontend will deep-link this to the SellerListingDetailPage where the user can add to cart.",
    "",
  ];

  // v6.1 Part 4: prepend the 1-line care summary if present (MIXED intent).
  // The LLM is instructed to use this as a brief care tip in the response —
  // saves a separate KB auto-inject DB call + ~1500 tokens of redundant
  // context.
  if (careSummary && careSummary.content) {
    lines.push(
      `CARE SUMMARY (1-line KB excerpt — include this in your response as a brief care tip alongside the buy recommendation): ${careSummary.content}`,
    );
    if (careSummary.sourceTitle) {
      lines.push(`  (source: ${careSummary.sourceTitle})`);
    }
    lines.push("");
  }

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
  // Postgres returns jsonb as a string when queried via raw `pool.query()`
  // without explicit casting. Callers that need the parsed array should
  // JSON.parse this — but for AI context purposes we treat it as opaque
  // text (the tsvector regex strips HTML tags either way).
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
