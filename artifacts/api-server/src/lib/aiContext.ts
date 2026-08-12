/**
 * Catalog context builder for the TreeBot assistant.
 *
 * The job of this module is to make the AI "aware" of what's in the
 * TreeFriend database WITHOUT exposing the database directly to the model.
 *
 * Pattern (Naive RAG, no embeddings):
 *   1. Take the user's message.
 *   2. Pull keywords from it.
 *   3. ILIKE-search `products` (name, scientific name, description) and
 *      `blog_posts` (title, body) for those keywords.
 *   4. Inject the top results into the system prompt as plain text.
 *
 * Why this works for our catalog size:
 *   - Typical marketplace catalogs have hundreds to low thousands of SKUs.
 *     Keyword search over `name` + `scientific_name` + `description`
 *     catches the relevant 5-10 products in a few ms.
 *   - Embedding-based search would be more accurate for fuzzy queries
 *     ("drought-resistant indoor plant") but adds a vector DB dependency,
 *     embedding pipeline, and re-indexing on every catalog change.
 *     Overkill for v1.
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
  "tree", "trees", "plant", "plants", "leaf", "leaves", "flower", "fruit",
  "seed", "seeds", "sapling", "saplings", "soil", "water", "watering",
  "sun", "sunlight", "shade", "light", "fertilizer", "fertilize", "pot",
  "pots", "garden", "gardening", "root", "roots", "branch", "branches",
  "stem", "stems", "bloom", "blooming", "prune", "pruning", "graft",
  "grafting", "bonsai", "indoor", "outdoor", "balcony", "terrace", "yard",
  "lawn", "orchard", "farm", "farming", "agriculture", "horticulture",
  "botanical", "botany", "photosynthesis", "compost", "mulch", "pest",
  "pests", "insect", "disease", "fungus", "mildew", "rot", "yellow",
  "wilting", "yellowing", "growth", "grow", "growing", "mature", "height",
  "spread", "variety", "species", "scientific", "evergreen", "deciduous",
  "perennial", "annual", "biennial", "herb", "shrub", "climber", "creeper",
  "cactus", "succulent", "palm", "bamboo", "mango", "jackfruit", "coconut",
  "neem", "banyan", "tamarind", "lemon", "guava", "lychee", "papaya",
  "banana", "rose", "jasmine", "hibiscus", "marigold", "orchid",
  // Bangla (Unicode)
  "গাছ", "চারা", "বীজ", "মাটি", "পানি", "রোদ", "ছায়া", "সার", "ফুল",
  "পাতা", "ফল", "বাগান", "শিকড", "ডাল", "গোলাপ", "বনসাই",
  // Banglish (common romanizations)
  "gach", "chara", "beej", "mati", "pani", "rod", "chaya", "sar", "phul",
  "pata", "phol", "bagan", "shidor", "dal", "golap",
] as const;

// ─── Public functions ────────────────────────────────────────────────────────

/**
 * Hard topic gate. Returns true if the message contains at least one
 * botanical/gardening keyword (English, Bangla Unicode, or Banglish).
 * Used by the route to refuse off-topic questions without spending API quota.
 *
 * Case-insensitive substring match is intentional — we want to catch
 * "tree", "Tree", "TREES", "treefriend", etc. False positives (e.g.
 * "potted" matching "pot") are acceptable because the soft gate (system
 * prompt) handles the actual refusal.
 */
export function hasBotanicalKeyword(message: string): boolean {
  const lower = message.toLowerCase();
  return BOTANICAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

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
        const desc = p.description
          ? truncate(p.description, MAX_SUMMARY_LEN)
          : "";
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
          `- "${p.name}" (slug: ${p.slug})${desc ? ` — ${desc}` : ""}` +
            (care ? ` [${care}]` : ""),
        );
      }
    }

    if (blogRows.length > 0) {
      lines.push("");
      lines.push("RELATED BLOG ARTICLES:");
      for (const b of blogRows) {
        const excerpt = b.excerpt
          ? truncate(b.excerpt, MAX_SUMMARY_LEN)
          : truncate(stripHtml(b.body ?? ""), MAX_SUMMARY_LEN);
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
 * context block. This is the single source of truth for the TreeBot
 * persona and scope rules — keep it tight and explicit.
 *
 * Rules enforced here:
 *   1. Topic scope: trees, plants, gardening, botany, TreeFriend catalog.
 *   2. Refusal: politely decline anything else.
 *   3. Language: reply in the same language as the user (EN/BN/Banglish).
 *   4. Catalog honesty: never invent prices, IDs, or availability.
 *   5. Length: concise (2-4 short paragraphs max).
 *   6. Recommendations: suggest /browse or /products when relevant.
 */
export function buildSystemPrompt(catalogContext: string): string {
  const contextBlock = catalogContext
    ? `\n\nCATALOG CONTEXT (use when relevant; cite exact product names):\n${catalogContext}\n`
    : `\n\nCATALOG CONTEXT: (no matching products or articles found for this query)\n`;

  return `You are TreeBot, the plant assistant for TreeFriend — a Bangladesh plant marketplace where buyers can purchase trees, saplings, and gardening supplies from multiple sellers.

YOUR SCOPE — STRICTLY ENFORCED:
You answer ONLY questions about:
- Trees, plants, plant care, gardening, botany
- Planting seasons, soil/water/light requirements
- Pests, diseases, propagation, pruning, grafting
- TreeFriend products, categories, blog articles
- Gardening in Bangladesh specifically (climate, monsoon, local species)

YOU MUST POLITELY REFUSE anything else (politics, sports, coding, math, celebrities, news, medical advice, etc.). Refusal template: "I'm TreeFriend's plant assistant and can only help with trees, plants, and gardening. Feel free to ask me about plant care or browse our catalog at /browse."

LANGUAGE: Reply in the same language as the user's message. Support English, বাংলা (Bengali Unicode), and Banglish (Bengali written in Latin script). If the user mixes languages, mirror their mix.

RULES:
- Never invent product prices, IDs, slugs, or availability you didn't see in the CATALOG CONTEXT.
- If a tree is in the catalog, recommend it by exact name (and mention it's available on TreeFriend).
- If a tree is NOT in the catalog, answer from general botanical knowledge — don't claim it's for sale.
- Be concise: 2-4 short paragraphs max. Use short sentences.
- Use bullet points for care instructions (e.g. "Water: 2x/week", "Sunlight: 4-6 hours").
- Suggest /browse (all trees) or /products (full catalog) when the user is shopping-oriented.
- Don't be sycophantic ("Great question!"). Just answer.${contextBlock}

REMEMBER: Stay strictly on-topic. If you're unsure whether a question is botanical, refuse politely.`;
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
  body: string | null;
}

function extractSearchTokens(message: string): string[] {
  // Split on whitespace + punctuation, keep tokens >=3 chars, drop pure
  // numbers and stop words. Cap at 5 tokens to keep the SQL reasonable.
  const STOP = new Set([
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "can", "i",
    "you", "he", "she", "it", "we", "they", "this", "that", "these",
    "those", "what", "which", "who", "when", "where", "why", "how",
    "for", "in", "on", "at", "to", "of", "with", "from", "by", "my",
    "me", "please", "tell", "give", "want", "need", "about",
  ]);

  const tokens = (message.toLowerCase().match(/[a-z\u0980-\u09ff]{3,}/gi) ?? [])
    .filter((t) => !STOP.has(t) && !/^\d+$/.test(t));

  // Dedupe + cap
  return Array.from(new Set(tokens)).slice(0, 5);
}

async function searchProducts(tokens: string[]): Promise<ProductRow[]> {
  if (tokens.length === 0) return [];
  // Build a single OR ILIKE clause: (name ILIKE '%t1%' OR scientific_name ILIKE '%t1%' OR ...)
  // Same tokens searched across name + scientific_name + description.
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
    // Primary path: respect the soft-delete column.
    const result = await pool.query(
      `SELECT name, slug, scientific_name, description, sunlight, watering,
              soil_type, mature_height, product_status
       FROM products
       WHERE is_deleted = false AND (${where})
       ORDER BY
         CASE WHEN name ILIKE ${namePriorityParam} THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT ${MAX_PRODUCTS}`,
      params,
    );
    return result.rows as ProductRow[];
  } catch {
    // Fallback: older DBs may not have the is_deleted column yet.
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

async function searchBlogPosts(tokens: string[]): Promise<BlogRow[]> {
  if (tokens.length === 0) return [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const t of tokens) {
    params.push(`%${t}%`);
    conditions.push(`title ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`excerpt ILIKE $${params.length}`);
    params.push(`%${t}%`);
    conditions.push(`body ILIKE $${params.length}`);
  }
  const where = conditions.join(" OR ");

  try {
    const result = await pool.query(
      `SELECT title, slug, excerpt, body
       FROM blog_posts
       WHERE is_published = true AND (${where})
       ORDER BY published_at DESC NULLS LAST, created_at DESC
       LIMIT ${MAX_BLOG_POSTS}`,
      params,
    );
    return result.rows as BlogRow[];
  } catch {
    // Fallback: no is_published / published_at column.
    const result = await pool.query(
      `SELECT title, slug, excerpt, body
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
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
