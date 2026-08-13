/**
 * Evaluation harness for the TreeBot assistant.
 *
 * Industry standard: test AI response quality against a golden dataset
 * before deploying prompt changes or switching models. Tools like
 * Promptfoo, LangSmith Evals, and OpenAI Evals all follow this pattern.
 *
 * How it works:
 *   1. A set of golden Q&A pairs is stored in `ai_eval_cases` (DB table).
 *   2. `runEval()` sends each question through the AI pipeline and
 *      compares the response against the expected answer using simple
 *      heuristics (keyword overlap, length, refusal detection).
 *   3. Results are stored in `ai_eval_results` for tracking over time.
 *   4. Admin can trigger an eval run via POST /api/ai/admin/eval/run
 *      and view results via GET /api/ai/admin/eval/results
 *
 * Evaluation metrics:
 *   - keyword_overlap: % of expected keywords found in the response
 *   - refused: whether the AI refused to answer (off-topic gate fired)
 *   - response_length: characters in the response (sanity check)
 *   - latency_ms: how long the response took
 *   - pass: keyword_overlap >= 0.5 AND !refused
 *
 * Limitations:
 *   This is a BASIC eval harness. For production-grade evaluation:
 *   - Use LLM-as-judge (have a strong model rate response quality 1-5)
 *   - Add semantic similarity (embeddings-based, not keyword overlap)
 *   - Add safety evals (does the response contain harmful advice?)
 *   - Add multi-turn evals (conversation coherence, not just single turns)
 *
 * These are documented as TODOs in the code. The basic harness is a
 * starting point — better than no evals, which is what most projects have.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvalCase {
  id: number;
  question: string;
  expectedKeywords: string[]; // keywords that should appear in a good response
  expectedRefusal: boolean; // true if the AI SHOULD refuse (off-topic question)
  category: string; // e.g. "plant_care", "product_search", "off_topic"
  notes: string | null;
}

export interface EvalResult {
  caseId: number;
  question: string;
  response: string;
  keywordOverlap: number; // 0-1
  refused: boolean;
  responseLength: number;
  latencyMs: number;
  passed: boolean;
  model: string;
  provider: string;
  error: string | null;
}

export interface EvalRunSummary {
  totalCases: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  avgKeywordOverlap: number;
  results: EvalResult[];
}

// ─── Golden dataset (seeded on first run) ────────────────────────────────────
// These are the "golden" Q&A pairs. The expectedKeywords are NOT the exact
// expected answer — they're keywords that a GOOD response should contain.
// This is intentionally fuzzy: there are many correct ways to answer
// "how often should I water a mango tree?" and we just check that the
// response mentions key concepts (watering frequency, season, soil moisture).

const SEED_CASES: Omit<EvalCase, "id">[] = [
  {
    question: "How often should I water a mango sapling?",
    expectedKeywords: ["water", "week", "soil", "dry"],
    expectedRefusal: false,
    category: "plant_care",
    notes: "Basic care question — should mention watering frequency + soil moisture",
  },
  {
    question: "What indoor plants are easy to care for in Bangladesh?",
    expectedKeywords: ["indoor", "easy", "plant"],
    expectedRefusal: false,
    category: "plant_care",
    notes: "Should recommend indoor plants suitable for Bangladesh climate",
  },
  {
    question: "When is the best season to plant a jackfruit tree?",
    expectedKeywords: ["season", "plant", "rainy", "monsoon"],
    expectedRefusal: false,
    category: "plant_care",
    notes: "Should mention the monsoon/rainy season as planting time",
  },
  {
    question: "Recommend shade-loving trees for a balcony",
    expectedKeywords: ["shade", "balcony", "plant"],
    expectedRefusal: false,
    category: "product_search",
    notes: "Should recommend shade-tolerant plants suitable for balconies",
  },
  {
    question: "What is the capital of France?",
    expectedKeywords: [],
    expectedRefusal: true,
    category: "off_topic",
    notes: "Off-topic question — should be refused politely",
  },
  {
    question: "Tell me a joke about trees",
    expectedKeywords: [],
    expectedRefusal: true,
    category: "off_topic",
    notes: "Off-topic (entertainment) — should be refused",
  },
  {
    question: "Write me a Python function to sort an array",
    expectedKeywords: [],
    expectedRefusal: true,
    category: "off_topic",
    notes: "Coding question — should be refused",
  },
  {
    question: "What are common pests that affect mango trees?",
    expectedKeywords: ["pest", "mango", "hopper", "mealybug"],
    expectedRefusal: false,
    category: "plant_care",
    notes: "Should mention common mango pests (hoppers, mealybugs, fruit flies)",
  },
  {
    question: "How do I propagate a plant from cuttings?",
    expectedKeywords: ["cutting", "propagate", "root", "water", "soil"],
    expectedRefusal: false,
    category: "plant_care",
    notes: "Should explain propagation by cuttings",
  },
  {
    question: "আমার বাগানে কোন গাছ লাগানো উচিত?", // "What trees should I plant in my garden?" (Bengali)
    expectedKeywords: ["গাছ", "বাগান"], // Should respond in Bengali
    expectedRefusal: false,
    category: "plant_care",
    notes: "Bengali language test — should respond in Bengali",
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensures the eval tables exist + seeds the golden dataset if empty.
 * Called by ensureAiTables.ts on server startup.
 */
export async function ensureEvalTables(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_cases (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        expected_keywords TEXT[] NOT NULL DEFAULT '{}',
        expected_refusal BOOLEAN NOT NULL DEFAULT FALSE,
        category TEXT NOT NULL DEFAULT 'general',
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_eval_results (
        id SERIAL PRIMARY KEY,
        case_id INTEGER NOT NULL REFERENCES ai_eval_cases(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        question TEXT NOT NULL,
        response TEXT NOT NULL,
        keyword_overlap REAL NOT NULL,
        refused BOOLEAN NOT NULL,
        response_length INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        passed BOOLEAN NOT NULL,
        model TEXT,
        provider TEXT,
        error TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS ai_eval_results_run_idx
        ON ai_eval_results (run_id);
      CREATE INDEX IF NOT EXISTS ai_eval_results_case_idx
        ON ai_eval_results (case_id, created_at DESC);
    `);

    // Seed golden cases if the table is empty
    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM ai_eval_cases");
    if (countResult.rows[0].count === 0) {
      for (const caseData of SEED_CASES) {
        await pool.query(
          `INSERT INTO ai_eval_cases (question, expected_keywords, expected_refusal, category, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            caseData.question,
            caseData.expectedKeywords,
            caseData.expectedRefusal,
            caseData.category,
            caseData.notes,
          ],
        );
      }
      logger.info({ count: SEED_CASES.length }, "Eval: seeded golden dataset");
    }
  } catch (err) {
    logger.error({ err }, "Eval: ensureEvalTables failed");
  }
}

/**
 * Loads all eval cases from the DB.
 */
export async function getEvalCases(): Promise<EvalCase[]> {
  try {
    const result = await pool.query(
      `SELECT id, question, expected_keywords, expected_refusal, category, notes
       FROM ai_eval_cases
       ORDER BY id ASC`,
    );
    return result.rows as EvalCase[];
  } catch (err) {
    logger.error({ err }, "Eval: getEvalCases failed");
    return [];
  }
}

/**
 * Evaluates a single response against an eval case.
 *
 * Metrics:
 *   - keyword_overlap: fraction of expected keywords found in the response
 *   - refused: whether the response contains refusal language
 *   - passed: keyword_overlap >= 0.5 (if not expected refusal) OR refused (if expected refusal)
 */
export function evaluateResponse(
  response: string,
  evalCase: EvalCase,
): { keywordOverlap: number; refused: boolean; passed: boolean } {
  const lowerResponse = response.toLowerCase();

  // Check for refusal language
  const refusalPatterns = [
    /i'm treefriend's plant assistant/i,
    /can only help with trees/i,
    /feel free to ask me about plant care/i,
    /browse our catalog/i,
  ];
  const refused = refusalPatterns.some((p) => p.test(response));

  // Calculate keyword overlap
  let foundKeywords = 0;
  for (const keyword of evalCase.expectedKeywords) {
    if (lowerResponse.includes(keyword.toLowerCase())) {
      foundKeywords++;
    }
  }
  const keywordOverlap =
    evalCase.expectedKeywords.length > 0
      ? foundKeywords / evalCase.expectedKeywords.length
      : 1; // no keywords expected → full overlap

  // Pass criteria:
  // - If expected refusal: passed = refused
  // - If not expected refusal: passed = keywordOverlap >= 0.5 AND !refused
  const passed = evalCase.expectedRefusal
    ? refused
    : keywordOverlap >= 0.5 && !refused;

  return { keywordOverlap, refused, passed };
}

/**
 * v3.4: LLM-as-judge evaluation.
 *
 * Uses a strong LLM to rate the response on 5 criteria (accuracy,
 * completeness, clarity, safety, tone) each on a 1-5 scale. This is
 * the industry-standard approach used by LangSmith, Helicone, and OpenAI Evals.
 *
 * Falls back to keyword matching if the judge is unavailable.
 *
 * @returns Enhanced eval result with judge scores + explanation
 */
export async function evaluateResponseWithJudge(
  question: string,
  response: string,
  evalCase: EvalCase,
): Promise<{
  keywordOverlap: number;
  refused: boolean;
  passed: boolean;
  judgeScore: number | null; // 1-5 overall, null if judge unavailable
  judgeExplanation: string | null;
  judgeCriteria: {
    accuracy: number;
    completeness: number;
    clarity: number;
    safety: number;
    tone: number;
  } | null;
}> {
  // First, do the basic keyword + refusal check (fast, free)
  const basic = evaluateResponse(response, evalCase);

  // If this is an expected-refusal case, skip the judge (refusals don't
  // need quality scoring — they just need to refuse correctly)
  if (evalCase.expectedRefusal) {
    return {
      ...basic,
      judgeScore: null,
      judgeExplanation: "Skipped (expected refusal case)",
      judgeCriteria: null,
    };
  }

  // Run LLM-as-judge
  const { judgeResponse } = await import("./llmAsJudge");
  const judgeResult = await judgeResponse(question, response);

  if (!judgeResult) {
    // Judge failed — fall back to keyword-based pass/fail
    return {
      ...basic,
      judgeScore: null,
      judgeExplanation: "Judge unavailable (fell back to keyword matching)",
      judgeCriteria: null,
    };
  }

  // LLM-as-judge pass criteria: overall >= 3.5 (out of 5)
  const judgePassed = judgeResult.overall >= 3.5;

  return {
    keywordOverlap: basic.keywordOverlap,
    refused: basic.refused,
    // Use judge score for pass/fail if available, otherwise keyword overlap
    passed: judgePassed,
    judgeScore: judgeResult.overall,
    judgeExplanation: judgeResult.explanation,
    judgeCriteria: {
      accuracy: judgeResult.accuracy,
      completeness: judgeResult.completeness,
      clarity: judgeResult.clarity,
      safety: judgeResult.safety,
      tone: judgeResult.tone,
    },
  };
}

/**
 * Saves an eval result to the DB (for historical tracking).
 */
export async function saveEvalResult(
  runId: string,
  evalCase: EvalCase,
  response: string,
  metrics: { keywordOverlap: number; refused: boolean; passed: boolean },
  latencyMs: number,
  model: string | null,
  provider: string | null,
  error: string | null = null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_eval_results
        (case_id, run_id, question, response, keyword_overlap, refused,
         response_length, latency_ms, passed, model, provider, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        evalCase.id,
        runId,
        evalCase.question,
        response,
        metrics.keywordOverlap,
        metrics.refused,
        response.length,
        latencyMs,
        metrics.passed,
        model,
        provider,
        error,
      ],
    );
  } catch (err) {
    logger.error({ err }, "Eval: saveEvalResult failed");
  }
}

/**
 * Returns historical eval results (for the admin dashboard).
 */
export async function getEvalResults(limit: number = 50): Promise<EvalResult[]> {
  try {
    const result = await pool.query(
      `SELECT
         case_id, run_id, question, response, keyword_overlap, refused,
         response_length, latency_ms, passed, model, provider, error,
         created_at
       FROM ai_eval_results
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(limit, 200)],
    );
    return result.rows as EvalResult[];
  } catch (err) {
    logger.error({ err }, "Eval: getEvalResults failed");
    return [];
  }
}
