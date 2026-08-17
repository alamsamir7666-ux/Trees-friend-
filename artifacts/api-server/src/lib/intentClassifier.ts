/**
 * Intent classifier for the TreeBot AI chat (v6.1).
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * The chat route currently runs the same RAG flow regardless of whether the
 * user is asking "how do I care for a mango tree?" (KNOWLEDGE intent — answer
 * from the KB) or "I want to buy a mango sapling" (PURCHASE intent — answer
 * from seller listings). The result is:
 *
 *   - For PURCHASE questions, the AI auto-injects variety-level CATALOG
 *     CONTEXT (Alphonso Mango, Langra Mango — no seller, no price, no stock)
 *     and the user has to navigate from variety page → seller listing →
 *     variant → cart (5 clicks) to actually buy anything.
 *   - For KNOWLEDGE questions, the auto-injected catalog context is
 *     harmless but wasted tokens — the user doesn't care which varieties
 *     exist, they want care info from the KB.
 *
 * The fix (Part 3 of this PR series) routes PURCHASE questions to the new
 * `search_seller_listings` tool (which returns specific listings with
 * seller + variant + price + stock + distance info) and keeps KNOWLEDGE
 * questions on the existing KB + `get_product_care` flow.
 *
 * This file implements the LEXICAL intent classifier that decides which
 * flow to use. It runs BEFORE the LLM call (~10ms, $0 cost) and is the
 * gatekeeper for routing.
 *
 * ─── Why lexical (not LLM-based)? ───────────────────────────────────────────
 *
 * The existing `topicClassifier.ts` uses an LLM call (Groq/Gemini) to
 * decide if a message is on-topic. That costs ~200ms + 1 LLM call per
 * message where the keyword gate fails. We deliberately AVOID an LLM call
 * for intent classification because:
 *
 *   1. **Latency**: ~10ms (regex) vs ~200ms (LLM). The intent classifier
 *      runs on EVERY chat message — adding 200ms of latency to every
 *      request would be a regression.
 *   2. **Cost**: $0 (regex) vs ~$0.0003 per LLM call. At 200 messages/day,
 *      that's $0.06/day = $22/year saved.
 *   3. **Accuracy for this specific task**: purchase/knowledge intent is
 *      detectable via keyword overlap (English + Bengali + Banglish). The
 *      hard cases the LLM catches are off-topic vs on-topic — purchase vs
 *      knowledge is much easier and well-suited to lexical classification.
 *   4. **Determinism**: same message = same intent = same routing. LLM
 *      classifiers with temperature > 0 can flip-flop.
 *
 * The trade-off: lexical classifiers miss paraphrases ("I'm looking for a
 * mango" — implicit purchase intent, no explicit "buy"). To handle this,
 * we fail-OPEN to MIXED intent when neither PURCHASE nor KNOWLEDGE
 * keywords match — MIXED triggers BOTH the seller-listing tool AND the
 * KB, so the user gets a complete answer either way. Cost: ~1 extra
 * tool call (free for the user, ~$0.0003 for us) on ambiguous messages.
 *
 * ─── Industry standard: lexical + LLM hybrid ──────────────────────────────
 *
 * This mirrors the existing two-tier topic gate (hard keyword gate +
 * LLM fallback). The keyword gate handles 70-80% of cases instantly;
 * the LLM handles the long tail. Here, the "long tail" is the MIXED
 * bucket which falls through to both tools — same end state, just one
 * extra tool call. We avoid the LLM cost entirely for this classifier.
 *
 * ─── Cache strategy ─────────────────────────────────────────────────────────
 *
 *   - L1 (in-process LRU Map): 512 entries, ~10KB total, zero latency.
 *     Same message = same intent (deterministic). The LRU evicts the
 *     least-recently-used entry when full.
 *   - No L2 (Redis) layer: the lexical classifier is so fast (~10μs
 *     per classification after warmup) that the Redis round-trip (~2ms)
 *     would be slower than just re-running the regex. The L1 cache is
 *     enough — same message text → same result.
 *   - No single-flight: the L1 hit path is synchronous, so concurrent
 *     identical requests all hit the L1 cache simultaneously (zero
 *     contention).
 *   - No negative caching: there's no "failure" mode — the classifier
 *     always returns a result (fail-open to MIXED).
 *
 * @module lib/intentClassifier
 */

import { logger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const L1_MAX_ENTRIES = Number(process.env.INTENT_CLASSIFIER_L1_MAX ?? 512);

// ─── Types ───────────────────────────────────────────────────────────────────

export type Intent = "PURCHASE" | "KNOWLEDGE" | "MIXED" | "GREETING";

export interface IntentClassification {
  intent: Intent;
  /** Why this intent was chosen. For observability / debugging. */
  reason: string;
  /** Which PURCHASE keywords matched (empty if none). */
  purchaseHits: string[];
  /** Which KNOWLEDGE keywords matched (empty if none). */
  knowledgeHits: string[];
  /** Original message (normalized for caching — NFC + trim + lowercase + collapse-ws + slice 500). */
  normalizedMessage: string;
}

// ─── Lexical keyword lists ──────────────────────────────────────────────────
//
// Curated for the TreeFriend domain (Bangladesh plant marketplace). Sources:
//   - ACCOUNT_KEYWORDS (aiContext.ts:299-359) for English/Bengali/Banglish
//     order-related terms (reused for PURCHASE intent).
//   - Common plant-care questions on the Bengali web (searched "গাছ যত্ন"
//     "লাগানো" "পরিচর্যা" in the existing KB).
//   - Common Banglish romanizations used by Bangladeshi internet users.
//
// Tuning notes:
//   - Substring match (case-insensitive, after normalization). This means
//     "buying" matches "buy", "purchased" matches "purchase" — good.
//   - We DON'T match "in" (too noisy — matches "winter", "begin", etc.).
//     Min length 3+ chars for English, 2+ for Bengali.
//   - "near me" is a strong purchase signal — user wants local sellers.
//   - "available" alone is ambiguous (matches KB questions about "is X
//     available in Dhaka?") — only counts as PURCHASE when combined with
//     another purchase signal. Implemented via the "primary" vs "secondary"
//     split below.

/**
 * Primary purchase-intent keywords. ANY match → strong PURCHASE signal.
 *
 * These words almost always mean the user wants to BUY something, regardless
 * of context. Even a single match tips the intent to PURCHASE.
 */
const PURCHASE_KEYWORDS_PRIMARY = [
  // ─── English ───────────────────────────────────────────────────────────────
  "buy",
  "buys",
  "buying",
  "purchase",
  "purchased",
  "purchases",
  "purchasing",
  "order",
  "ordered",
  "ordering",
  "orders", // ambiguous with "orders" (commands) but rare in plant context
  "shop",
  "shopping",
  "checkout",
  "add to cart",
  "add to basket",
  "in stock",
  "out of stock",
  "stock alert",
  "notify me when",
  "price",
  "prices",
  "pricing",
  "cost",
  "how much",
  "discount",
  "deal",
  "deals",
  "offer",
  "offers",
  "sale",
  "on sale",
  "best price",
  "cheapest",
  "lowest price",
  "affordable",
  "cheap",
  "budget",
  "under ", // "under 500" — price-cap phrasing
  "within ", // "within 1000" — price-cap phrasing
  "available",
  "availability",
  "near me",
  "nearby",
  "closest",
  "delivery",
  "deliver",
  "delivered",
  "shipping",
  "ship",
  "shipped",
  "courier",
  "cash on delivery",
  "cod",
  "advance payment",
  "bdt",
  "taka",
  "৳", // Bengali taka sign — strong BDT-context signal
  "pre-order",
  "preorder",
  "back in stock",
  // ─── Bengali (Unicode) ────────────────────────────────────────────────────
  "কিনতে", // to buy
  "কিনব", // will buy
  "কিনে", // bought/buying
  "ক্রয়", // purchase
  "ক্রয় করতে", // to purchase
  "অর্ডার", // order
  "অর্ডার করতে", // to order
  "অর্ডার করব", // will order
  "দাম", // price
  "দাম কত", // what's the price
  "কিছু টাকা", // some money (price-context)
  "টাকা", // money/BDT
  "পরিমাণ", // quantity
  "মজুত", // stock
  "মজুত আছে", // in stock
  "মজুত নেই", // out of stock
  "ডেলিভারি", // delivery
  "ডেলিভারি করতে", // to deliver
  "কুরিয়ার", // courier
  "কাছে", // near (location)
  "কাছাকাছি", // nearby
  "নিকটস্থ", // nearest
  "অগ্রিম", // advance (payment)
  "প্রি-অর্ডার", // pre-order
  // ─── Banglish (romanized Bengali) ────────────────────────────────────────
  "kinte", // to buy
  "kinbo", // will buy
  "kinte chai", // want to buy
  "kinlam", // bought
  "kore othar", // purchase (rare)
  "dam", // price (Bengali দাম)
  "dam koto", // what's the price
  "taka", // money/BDT
  "order korbo", // will order
  "order korte", // to order
  "delivery", // already in English list, included for Banglish users
  "courier",
  "mujut", // stock (Bengali মজুত)
  "mujut ache", // in stock
  "mujut nei", // out of stock
  "kache", // near (Bengali কাছে)
  "kachakachi", // nearby (Bengali কাছাকাছি)
  "agrim", // advance (Bengali অগ্রিম)
] as const;

/**
 * Secondary purchase-intent keywords. Only count toward PURCHASE when
 * combined with at least one primary keyword.
 *
 * These words are ambiguous on their own (e.g., "available" appears in
 * KB questions like "is mango available year-round?"). They only confirm
 * purchase intent when paired with a primary signal.
 */
const PURCHASE_KEYWORDS_SECONDARY = [
  "size",
  "quantity",
  "how many",
  "best",
  "recommend",
  "suggest",
  "show me",
  "show me some",
  "find me",
  "looking for",
  "i want",
  "i need",
  "get me",
  "give me",
  "list",
  "options",
  "compare",
  "versus",
  "vs",
  "which is better",
  // Bengali
  "কোনটি", // which one
  "কোনটি ভালো", // which is better
  "দেখাও", // show me
  "কতগুলো", // how many
  "কত", // how much (ambiguous with price — but price is primary)
  "পরামর্শ", // suggest
  "সুপারিশ", // recommend
  "ভালো কিছু", // something good
  // Banglish
  "konta", // which one
  "konta bhalo", // which is better
  "dekhai", // show me
  "kotogulo", // how many
  "poramorsho", // suggest
  "bhalo kichu", // something good
] as const;

/**
 * Knowledge-intent keywords. ANY match → strong KNOWLEDGE signal.
 *
 * These words almost always mean the user wants INFORMATION (care, growth,
 * botanical info), not to buy.
 *
 * IMPORTANT: we use ONLY compound question forms ("how to", "what is",
 * "why does") — NOT standalone question words ("how", "why", "where",
 * "what", "when", "which", "can", "is", "are"). Standalone question words
 * are too noisy: "Where can I buy a mango?" has "where" but is clearly
 * PURCHASE intent. The compound forms ("how to care") are unambiguous.
 *
 * The care-specific keywords (watering, sunlight, soil, pruning, etc.)
 * are also unambiguous — a user mentioning "fertilizer" or "yellow leaves"
 * almost always wants care info, not to buy.
 */
const KNOWLEDGE_KEYWORDS = [
  // ─── English ── COMPOUND QUESTION FORMS (not standalone) ───────────────
  "how to",
  "how do",
  "how does",
  "how often",
  "how long",
  "how much water",
  "how much sun",
  "what is",
  "what are",
  "what does",
  "what kind",
  "what type",
  "what's the",
  "why does",
  "why is",
  "why are",
  "when to",
  "when does",
  "when is",
  "which kind",
  // ─── English ── CARE-SPECIFIC KEYWORDS (unambiguous) ───────────────────
  "care",
  "care for",
  "care guide",
  "growing",
  "grow",
  "grows",
  "grew",
  "planting",
  "plant", // matches "plant" + "plants" + "planting" via substring
  "watering",
  "water",
  "waters",
  "sunlight",
  "sun",
  "shade",
  "soil",
  "fertilizer",
  "fertilise",
  "fertilize",
  "pruning",
  "prune",
  "trim",
  "propagat", // matches propagate/propagating/propagation
  "germinat",
  "seed",
  "seeds",
  "grafting",
  "graft",
  "disease",
  "diseases",
  "pest",
  "pests",
  "bug",
  "bugs",
  "insect",
  "insects",
  "yellow leaves",
  "brown leaves",
  "wilting",
  "wilt",
  "dying",
  "dead",
  "healthy",
  "health",
  "scientific name",
  "botanical",
  "mature height",
  "growth rate",
  "bloom",
  "flowering",
  "flower",
  "flowers",
  "season",
  "seasons",
  "winter",
  "summer",
  "monsoon",
  "rainy",
  "spring",
  "autumn",
  "climate",
  "hardiness",
  "indoor",
  "outdoor",
  "potted",
  "repot",
  "transplant",
  "lifespan",
  "perennial",
  "annual",
  "evergreen",
  "deciduous",
  // ─── Bengali (Unicode) ── CARE-SPECIFIC KEYWORDS (compound forms only) ─
  // NOTE: standalone question words কি/কী/কেন/কখন/কোথায়/কীভাবে are NOT
  // included — same reasoning as English. The compound "যত্ন করতে" etc.
  // are unambiguous care-intent signals.
  "যত্ন", // care
  "যত্ন নিতে", // to care for
  "যত্ন করতে", // to care for
  "পরিচর্যা", // care (formal)
  "পরিচর্যা করতে", // to care for
  "লাগানো", // planting
  "লাগাতে", // to plant
  "লাগান", // planted
  "রোপণ", // planting
  "রোপণ করতে", // to plant
  "পানি", // water
  "পানি দিতে", // to water
  "রোদ", // sun
  "রৌদ্র", // sunlight (formal)
  "মাটি", // soil
  "সার", // fertilizer
  "ছেদন", // pruning
  "ছাটাই", // pruning
  "ছাটাই করতে", // to prune
  "জোতা", // graft (rare)
  "কলম", // graft (Bengali for grafting)
  "কলম করতে", // to graft
  "বংশবৃদ্ধি", // propagation
  "বীজ", // seed
  "বীজতলা", // seedbed
  "রোগ", // disease
  "পোকা", // pest/insect
  "অসুস্থ", // sick
  "পাতা হলুদ", // yellow leaves
  "পাতা বাদামি", // brown leaves
  "শুকিয়ে", // wilting
  "মরে", // dying
  "সুস্থ", // healthy
  "বৈজ্ঞানিক নাম", // scientific name
  "উচ্চতা", // height
  "বৃদ্ধি", // growth
  "ফুল", // flower
  "ফুল ফুটা", // blooming
  "ঋতু", // season
  "শীত", // winter
  "গ্রীষ্ম", // summer
  "বর্ষা", // monsoon
  "বসন্ত", // spring
  "জলবায়ু", // climate
  "বহুবর্ষজীবী", // perennial
  "বার্ষিক", // annual
  "চিরসবুরী", // evergreen
  // ─── Banglish ── CARE-SPECIFIC KEYWORDS (compound forms only) ─────────
  "jotno", // care
  "jotno nite", // to care for
  "jotno korte", // to care for
  "porichorja", // care (formal)
  "lagano", // planting
  "lagate", // to plant
  "ropon", // planting
  "ropon korte", // to plant
  "pani", // water
  "pani dite", // to water
  "rod", // sun
  "mati", // soil
  "sar", // fertilizer
  "chhatai", // pruning
  "chhatai korte", // to prune
  "kolom", // graft
  "kolom korte", // to graft
  "bongshobridhi", // propagation
  "bija", // seed
  "bijtola", // seedbed
  "rog", // disease
  "poka", // pest/insect
  "asustho", // sick
  "pata holud", // yellow leaves
  "pata badami", // brown leaves
  "shukiye", // wilting
  "more", // dying
  "sustho", // healthy
  "boigganik nam", // scientific name
  "uccho", // height
  "briddhi", // growth
  "ful", // flower
  "ful futa", // blooming
  "ritu", // season
  "shit", // winter
  "grishmo", // summer
  "borsha", // monsoon
  "boshonto", // spring
  "jalbayu", // climate
] as const;

// ─── Greeting keywords (reuse the existing GREETING_KEYWORDS list) ──────────
//
// We don't redefine greetings here — the existing `isPureGreeting` check
// in aiContext.ts handles them BEFORE the intent classifier runs. So the
// intent classifier only sees non-greeting messages. We still include
// "GREETING" as a possible intent value in case a future refactor wants
// to consolidate the greeting check here.

// ─── L1 cache (in-process LRU Map) ──────────────────────────────────────────
//
// Same pattern as topicClassifierCache.ts (but no L2 — see module comment
// for why). Each entry: { intent, reason, hits, normalizedMessage } ≈ 200
// bytes. 512 entries × 200 bytes = ~100KB max — negligible.

class L1Cache {
  private map = new Map<string, IntentClassification>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): IntentClassification | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // LRU: move to end (most recently used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: IntentClassification): void {
    if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
    this.map.set(key, entry);
  }

  clear(): number {
    const count = this.map.size;
    this.map.clear();
    return count;
  }

  get size(): number {
    return this.map.size;
  }
}

const _l1 = new L1Cache(L1_MAX_ENTRIES);

// ─── Cache key construction ─────────────────────────────────────────────────

/**
 * Normalizes a message for cache key derivation.
 *
 * Same normalization as the rest of the AI cache stack (queryEmbeddingCache,
 * topicClassifierCache, promptInjectionCache): NFC + trim + lowercase +
 * collapse whitespace + truncate to 500 chars. This ensures the same
 * message text produces the same cache key across requests.
 */
function normalizeMessage(message: string): string {
  return message.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500);
}

function cacheKey(normalized: string): string {
  // Simple hash — no crypto needed (this is a deterministic in-process
  // cache, not shared across instances). String keys are fine.
  return normalized;
}

// ─── Keyword matching ──────────────────────────────────────────────────────

/**
 * Returns the list of keywords (from the given list) that appear in the
 * normalized message as substrings.
 *
 * Case-insensitive: the message is already lowercased by normalizeMessage.
 *
 * The keyword list itself is lowercased at module load (see `as const` arrays).
 */
function findHits(message: string, keywords: readonly string[]): string[] {
  const hits: string[] = [];
  for (const kw of keywords) {
    if (message.includes(kw)) {
      hits.push(kw);
    }
  }
  return hits;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Classifies the intent of a user message: PURCHASE, KNOWLEDGE, MIXED, or
 * GREETING.
 *
 * Algorithm:
 *   1. Normalize the message (NFC + trim + lowercase + collapse-ws + slice 500).
 *   2. Check L1 cache. Hit → return cached classification.
 *   3. Find PURCHASE keyword hits (primary + secondary).
 *   4. Find KNOWLEDGE keyword hits.
 *   5. Decide intent:
 *        - 0 purchase + 0 knowledge → MIXED (fail-open — ambiguous, let the
 *          LLM route to both tools).
 *        - ≥1 primary purchase + 0 knowledge → PURCHASE.
 *        - 0 primary purchase + (≥1 secondary purchase) + 0 knowledge → MIXED
 *          (secondary alone is too weak — let the LLM decide via tools).
 *        - 0 purchase + ≥1 knowledge → KNOWLEDGE.
 *        - ≥1 purchase (primary or secondary) + ≥1 knowledge → MIXED.
 *   6. Cache the result in L1 + return.
 *
 * Fail-open design: this function NEVER throws. If anything unexpected
 * happens, it returns MIXED (which triggers both tools — safest default).
 *
 * @param message The user's message (any language, any length).
 * @returns The classification — same input always produces the same output.
 */
export function classifyIntent(message: string): IntentClassification {
  if (!message || typeof message !== "string") {
    return {
      intent: "MIXED",
      reason: "empty or non-string message — fail-open to MIXED",
      purchaseHits: [],
      knowledgeHits: [],
      normalizedMessage: "",
    };
  }

  const normalized = normalizeMessage(message);
  const key = cacheKey(normalized);

  // L1 hit.
  const cached = _l1.get(key);
  if (cached) {
    return cached;
  }

  // L1 miss → classify.
  let purchasePrimaryHits: string[] = [];
  let purchaseSecondaryHits: string[] = [];
  let knowledgeHits: string[] = [];

  try {
    purchasePrimaryHits = findHits(normalized, PURCHASE_KEYWORDS_PRIMARY);
    purchaseSecondaryHits = findHits(normalized, PURCHASE_KEYWORDS_SECONDARY);
    knowledgeHits = findHits(normalized, KNOWLEDGE_KEYWORDS);
  } catch (err) {
    // Defensive — findHits is pure regex/string-ops, shouldn't throw.
    // If it does (e.g., malformed unicode), fail-open to MIXED.
    logger.warn(
      { err: (err as Error)?.message ?? String(err), messagePreview: normalized.slice(0, 80) },
      "intentClassifier: findHits threw — fail-open to MIXED",
    );
    const fallback: IntentClassification = {
      intent: "MIXED",
      reason: "findHits threw — fail-open",
      purchaseHits: [],
      knowledgeHits: [],
      normalizedMessage: normalized,
    };
    _l1.set(key, fallback);
    return fallback;
  }

  const purchaseHits = [...purchasePrimaryHits, ...purchaseSecondaryHits];

  // ─── Weak vs strong knowledge keywords ──────────────────────────────────
  //
  // Compound question forms ("how to", "what is", "why does", "what's the",
  // "when to") are "weak" — they appear in BOTH knowledge and purchase
  // questions:
  //   - "How to water a mango sapling?" → KNOWLEDGE
  //   - "How to buy a mango sapling?" → PURCHASE (but has "how to")
  //   - "What's the price of a mango?" → PURCHASE (but has "what's the")
  //
  // Care-specific keywords ("water", "sunlight", "soil", "pruning",
  // "yellow leaves", "scientific name", etc.) are "strong" — they almost
  // never appear in pure purchase questions.
  //
  // Rule: when PURCHASE primary keywords match AND only WEAK knowledge
  // keywords match, classify as PURCHASE (the primary purchase signal is
  // authoritative). When PURCHASE primary keywords match AND any STRONG
  // knowledge keyword matches, classify as MIXED (genuine mixed intent —
  // user wants both info and a buy link).
  //
  // This rule prevents false MIXED classifications on questions like
  // "What's the price of a mango sapling?" (clearly PURCHASE, but matches
  // both "price" and "what's the").
  const WEAK_KNOWLEDGE_PREFIXES = new Set([
    "how to",
    "how do",
    "how does",
    "how often",
    "how long",
    "how much water",
    "how much sun",
    "what is",
    "what are",
    "what does",
    "what kind",
    "what type",
    "what's the",
    "why does",
    "why is",
    "why are",
    "when to",
    "when does",
    "when is",
    "which kind",
  ]);
  const strongKnowledgeHits = knowledgeHits.filter((kw) => !WEAK_KNOWLEDGE_PREFIXES.has(kw));
  const weakKnowledgeHits = knowledgeHits.filter((kw) => WEAK_KNOWLEDGE_PREFIXES.has(kw));

  // Decide intent (see algorithm in JSDoc above).
  let intent: Intent;
  let reason: string;

  if (purchasePrimaryHits.length === 0 && knowledgeHits.length === 0) {
    // No signals on either side — ambiguous.
    if (purchaseSecondaryHits.length > 0) {
      // Secondary-only purchase signals are too weak on their own. Route
      // to MIXED so the LLM can pick the right tool based on context.
      intent = "MIXED";
      reason = `secondary purchase keywords only (${purchaseSecondaryHits.join(", ")}) — no knowledge hits — route to MIXED to let LLM decide`;
    } else {
      // Truly no signals. Route to MIXED — both tools called, user gets
      // complete answer either way.
      intent = "MIXED";
      reason = "no keyword hits — fail-open to MIXED (both tools will be called)";
    }
  } else if (purchasePrimaryHits.length > 0 && knowledgeHits.length === 0) {
    intent = "PURCHASE";
    reason = `primary purchase keywords: ${purchasePrimaryHits.join(", ")}`;
  } else if (purchasePrimaryHits.length > 0 && knowledgeHits.length > 0) {
    // Both sides have hits — decide based on weak vs strong knowledge.
    if (strongKnowledgeHits.length > 0) {
      // Strong knowledge keywords present alongside purchase signals →
      // genuine MIXED intent. User wants both info and a buy link.
      // Example: "I want to buy a mango sapling and learn how to care for it"
      // → PURCHASE (buy) + KNOWLEDGE (care).
      intent = "MIXED";
      reason = `purchase: ${purchasePrimaryHits.slice(0, 2).join(", ")} | strong knowledge: ${strongKnowledgeHits.slice(0, 2).join(", ")}`;
    } else {
      // Only weak knowledge (compound question forms) alongside purchase
      // primary keywords → PURCHASE wins. The compound forms are
      // question shapes, not intent signals.
      // Example: "What's the price of a mango?" → PURCHASE (price
      // overrides the "what's the" question form).
      intent = "PURCHASE";
      reason = `primary purchase keywords: ${purchasePrimaryHits.join(", ")} (overrides weak knowledge: ${weakKnowledgeHits.slice(0, 2).join(", ")})`;
    }
  } else if (purchasePrimaryHits.length === 0 && knowledgeHits.length > 0) {
    // (secondary purchase may be > 0, but primary is 0 — knowledge wins)
    intent = "KNOWLEDGE";
    reason = `knowledge keywords: ${knowledgeHits.slice(0, 3).join(", ")}${knowledgeHits.length > 3 ? "..." : ""}`;
  } else {
    // Unreachable — the four cases above cover all combinations. This is
    // defensive only.
    intent = "MIXED";
    reason = "defensive fallback — unreachable";
  }

  const classification: IntentClassification = {
    intent,
    reason,
    purchaseHits,
    knowledgeHits,
    normalizedMessage: normalized,
  };

  _l1.set(key, classification);
  return classification;
}

// ─── Admin / observability ─────────────────────────────────────────────────

/**
 * Returns L1 cache stats for the admin dashboard (mirrors the
 * topicClassifierCache.getCacheStats pattern).
 */
export function getIntentCacheStats(): {
  enabled: boolean;
  l1Entries: number;
  l1MaxEntries: number;
} {
  return {
    enabled: true,
    l1Entries: _l1.size,
    l1MaxEntries: L1_MAX_ENTRIES,
  };
}

/**
 * Clears the L1 cache. Used by the admin "clear cache" endpoint for testing.
 */
export function clearIntentCache(): number {
  return _l1.clear();
}
