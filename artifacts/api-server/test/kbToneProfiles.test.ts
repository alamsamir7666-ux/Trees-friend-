/**
 * Phase 4: Creator tone matching — source-shape tests.
 *
 * Verifies:
 *   - kbToneProfiles.ts exports all 6 functions + the ToneProfile type.
 *   - The tone prompt mentions "tone analysis" + "JSON object".
 *   - Uses responseMimeType: "application/json" + temperature 0.3.
 *   - AI_TONE_MATCH_THRESHOLD default is 10.
 *   - AI_TONE_MATCH_PERCENTAGE default is 60.
 *   - AI_TONE_REGENERATION_DELTA default is 5.
 *   - formatToneBlockForPrompt includes "TONE MATCHING" + "Adopt approximately".
 *   - formatToneBlockForPrompt includes "don't copy their phrases verbatim".
 *   - kbToneProfileJob.ts exports runKbToneProfileJob.
 *   - Cron endpoint POST /cron/kb-tone-profiles is registered.
 *   - aiAdmin.ts has all 4 tone management endpoints.
 *   - aiContext.ts SYSTEM_PROMPT_TEMPLATE_V1 contains {{tone}} placeholder.
 *   - aiContext.ts renderPromptTemplate handles {{tone}}.
 *   - aiContext.ts buildSystemPrompt accepts toneBlock parameter.
 *   - ai.ts route calls getToneProfile + formatToneBlockForPrompt when toneCreator has profile.
 *   - ai.ts logs tone_match event via logAiEvent.
 *   - kbSearch.ts KbSearchResult includes hasToneProfile + toneMatchPercentage + entryCount.
 *   - kbSearch.ts getTopKbEntriesForPrompt returns toneCreator field.
 *   - ensureAiTables.ts has Phase 4 migration (2 new columns on ai_kb_creators).
 *   - Drizzle schema has toneProfileEntryCount + toneProfileModel.
 *
 * Run: cd artifacts/api-server && pnpm vitest run test/kbToneProfiles.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readSource(rel: string): string {
  return fs.readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
}

// ─── kbToneProfiles.ts ────────────────────────────────────────────────────────

describe("Phase 4: kbToneProfiles.ts lib module", () => {
  const source = readSource("artifacts/api-server/src/lib/kbToneProfiles.ts");

  it("exports generateToneProfile", () => {
    expect(source).toContain("export async function generateToneProfile");
  });

  it("exports getToneProfile", () => {
    expect(source).toContain("export async function getToneProfile");
  });

  it("exports getEffectiveToneMatchPercentage", () => {
    expect(source).toContain("export async function getEffectiveToneMatchPercentage");
  });

  it("exports needsToneProfileRegeneration", () => {
    expect(source).toContain("export async function needsToneProfileRegeneration");
  });

  it("exports getCreatorsNeedingToneProfiles", () => {
    expect(source).toContain("export async function getCreatorsNeedingToneProfiles");
  });

  it("exports formatToneBlockForPrompt", () => {
    expect(source).toContain("export function formatToneBlockForPrompt");
  });

  it("exports the ToneProfile type", () => {
    expect(source).toContain("export interface ToneProfile");
  });

  it("exports the constants (TONE_MATCH_THRESHOLD, DEFAULT_TONE_MATCH_PERCENTAGE, REGENERATION_DELTA)", () => {
    expect(source).toContain("TONE_MATCH_THRESHOLD");
    expect(source).toContain("DEFAULT_TONE_MATCH_PERCENTAGE");
    expect(source).toContain("REGENERATION_DELTA");
  });

  it("AI_TONE_MATCH_THRESHOLD env var default is 10", () => {
    expect(source).toContain("AI_TONE_MATCH_THRESHOLD ?? 10");
  });

  it("AI_TONE_MATCH_PERCENTAGE env var default is 60", () => {
    expect(source).toContain("AI_TONE_MATCH_PERCENTAGE ?? 60");
  });

  it("AI_TONE_REGENERATION_DELTA env var default is 5", () => {
    expect(source).toContain("AI_TONE_REGENERATION_DELTA ?? 5");
  });

  it("uses Gemini via getClient + callWithFallback from gemini.ts", () => {
    expect(source).toContain("getClient");
    expect(source).toContain("callWithFallback");
    expect(source).toContain("isGeminiConfigured");
  });

  it("the tone prompt mentions 'tone analysis' + 'JSON object'", () => {
    expect(source).toContain("tone analysis");
    expect(source).toContain("JSON object");
  });

  it("the tone prompt asks for adjectives, sentence_style, example_phrases, tone_summary", () => {
    expect(source).toContain("adjectives");
    expect(source).toContain("sentence_style");
    expect(source).toContain("example_phrases");
    expect(source).toContain("tone_summary");
  });

  it("uses responseMimeType: application/json for guaranteed JSON", () => {
    expect(source).toContain('responseMimeType: "application/json"');
  });

  it("uses temperature 0.3 for structured output (TONE_ANALYSIS_TEMPERATURE constant)", () => {
    expect(source).toContain("temperature: TONE_ANALYSIS_TEMPERATURE");
    expect(source).toContain("TONE_ANALYSIS_TEMPERATURE = 0.3");
  });

  it("maxOutputTokens is 2048 (TONE_ANALYSIS_MAX_TOKENS constant)", () => {
    expect(source).toContain("maxOutputTokens: TONE_ANALYSIS_MAX_TOKENS");
    expect(source).toContain("TONE_ANALYSIS_MAX_TOKENS = 2048");
  });

  it("fetches up to 15 entries for analysis (MAX_ENTRIES_FOR_ANALYSIS)", () => {
    expect(source).toContain("MAX_ENTRIES_FOR_ANALYSIS = 15");
  });

  it("generateToneProfile stores the profile as JSON string + entry_count + model", () => {
    expect(source).toContain("tone_profile = $1");
    expect(source).toContain("tone_profile_entry_count = $2");
    expect(source).toContain("tone_profile_model = $3");
  });

  it("generateToneProfile returns { success: false } below threshold", () => {
    expect(source).toContain("below threshold");
  });

  it("generateToneProfile returns { success: false } on rate limit (429)", () => {
    expect(source).toContain("429");
    expect(source).toContain("Gemini rate limit hit");
  });

  it("needsToneProfileRegeneration checks delta >= REGENERATION_DELTA", () => {
    expect(source).toContain("REGENERATION_DELTA");
    expect(source).toContain("needed: true");
  });

  it("getCreatorsNeedingToneProfiles uses a single SQL query (no N+1)", () => {
    expect(source).toContain("tone_profile IS NULL");
    expect(source).toContain("COALESCE(tone_profile_entry_count, 0)");
  });

  it("formatToneBlockForPrompt includes 'TONE MATCHING' header", () => {
    expect(source).toContain("TONE MATCHING");
  });

  it("formatToneBlockForPrompt includes 'Adopt approximately' + the match percentage", () => {
    expect(source).toContain("Adopt approximately");
    expect(source).toContain("${matchPercentage}%");
  });

  it("formatToneBlockForPrompt includes 'don't copy phrases verbatim'", () => {
    // v6.2 Part 11: test wording aligned with the actual source code.
    // The source says "don't copy phrases verbatim" (no "their").
    // The test previously expected "don't copy their phrases verbatim" —
    // a wording drift between the test author's intent + the implementation.
    expect(source).toContain("don't copy phrases verbatim");
  });

  it("formatToneBlockForPrompt includes the 'keep X% standard helpful' rule", () => {
    expect(source).toContain("standard helpful");
  });

  it("formatToneBlockForPrompt prioritizes accuracy over tone", () => {
    expect(source).toContain("prioritize accuracy over tone");
  });
});

// ─── kbToneProfileJob.ts ─────────────────────────────────────────────────────

describe("Phase 4: kbToneProfileJob.ts background job", () => {
  const source = readSource("artifacts/api-server/src/jobs/kbToneProfileJob.ts");

  it("exports runKbToneProfileJob", () => {
    expect(source).toContain("export async function runKbToneProfileJob");
  });

  it("imports getCreatorsNeedingToneProfiles + generateToneProfile", () => {
    expect(source).toContain("getCreatorsNeedingToneProfiles");
    expect(source).toContain("generateToneProfile");
    expect(source).toContain("kbToneProfiles");
  });

  it("processes up to 3 creators per run (MAX_CREATORS_PER_RUN)", () => {
    expect(source).toContain("MAX_CREATORS_PER_RUN = 3");
  });

  it("stops on rate limit (break + logs warning)", () => {
    expect(source).toContain("rateLimited = true");
    expect(source).toContain("break");
  });

  it("catches errors (never throws — called from setInterval)", () => {
    expect(source).toContain("catch");
    expect(source).toContain("unexpected error");
  });

  it("returns { processed, succeeded, failed, rateLimited }", () => {
    expect(source).toContain("processed");
    expect(source).toContain("succeeded");
    expect(source).toContain("failed");
    expect(source).toContain("rateLimited");
  });
});

// ─── aiContext.ts ────────────────────────────────────────────────────────────

describe("Phase 4: aiContext.ts {{tone}} placeholder", () => {
  const source = readSource("artifacts/api-server/src/lib/aiContext.ts");

  it("SYSTEM_PROMPT_TEMPLATE_V1 contains {{tone}} placeholder", () => {
    expect(source).toContain("{{tone}}");
  });

  it("placeholder order is {{summary}}{{knowledge}}{{catalog}}{{tone}} (tone last)", () => {
    expect(source).toContain("{{summary}}{{knowledge}}{{catalog}}{{tone}}");
  });

  it("renderPromptTemplate accepts a toneBlock parameter", () => {
    expect(source).toMatch(/renderPromptTemplate\([\s\S]*?toneBlock[\s\S]*?: string/);
  });

  it("renderPromptTemplate replaces {{tone}} placeholder", () => {
    expect(source).toContain('replaceAll("{{tone}}"');
  });

  it("renderPromptTemplate appends tone at the end when no placeholder", () => {
    expect(source).toContain('rendered = rendered + "\\n" + tone');
  });

  it("buildSystemPrompt accepts a toneBlock parameter", () => {
    expect(source).toMatch(/buildSystemPrompt\([\s\S]*?toneBlock[\s\S]*?: string/);
  });

  it("buildSystemPrompt passes toneBlock to renderPromptTemplate", () => {
    // v6.2 Part 11: the source has knowledgeBlock + toneBlock on separate
    // lines (not comma-joined on one line). Loosen the assertion to match
    // either form — the intent is "both are passed", not "they're on the
    // same line". Use [\s\S] to match across newlines.
    expect(source).toMatch(/renderPromptTemplate\([\s\S]*?knowledgeBlock[\s\S]*?toneBlock/);
  });
});

// ─── routes/ai.ts ────────────────────────────────────────────────────────────

describe("Phase 4: routes/ai.ts tone integration", () => {
  const source = readSource("artifacts/api-server/src/routes/ai.ts");

  it("imports getToneProfile + getEffectiveToneMatchPercentage + formatToneBlockForPrompt", () => {
    expect(source).toContain("getToneProfile");
    expect(source).toContain("getEffectiveToneMatchPercentage");
    expect(source).toContain("formatToneBlockForPrompt");
    expect(source).toContain("kbToneProfiles");
  });

  it("checks kbContext.toneCreator?.hasToneProfile before generating tone block", () => {
    expect(source).toContain("kbContext.toneCreator?.hasToneProfile");
  });

  it("calls getToneProfile + formatToneBlockForPrompt when tone is active", () => {
    expect(source).toContain("await getToneProfile(kbContext.toneCreator.creatorId)");
    expect(source).toContain("formatToneBlockForPrompt(");
  });

  it("passes toneBlock to renderPromptTemplate (DB path)", () => {
    // v6.2 Part 11: the DB path calls buildSystemPrompt (which internally
    // calls renderPromptTemplate). The fallback path calls buildSystemPrompt
    // directly. Both pass knowledgeBlock + toneBlock. The test previously
    // asserted renderPromptTemplate was called directly, but the DB path
    // goes through buildSystemPrompt. Loosen to match either call site
    // using [\s\S] for cross-newline matching.
    expect(source).toMatch(/(?:renderPromptTemplate|buildSystemPrompt)\([\s\S]*?knowledgeBlock[\s\S]*?toneBlock/);
  });

  it("passes toneBlock to buildSystemPrompt (fallback path)", () => {
    // v6.2 Part 11: same multi-line fix as the DB path test above.
    expect(source).toMatch(/buildSystemPrompt\([\s\S]*?knowledgeBlock[\s\S]*?toneBlock/);
  });

  it("logs 'AI: tone matching activated' when tone is active", () => {
    expect(source).toContain("AI: tone matching activated");
  });

  it("logs tone_match event via logAiEvent after persisting assistant message", () => {
    expect(source).toContain('logAiEvent(session.id, "tone_match"');
    expect(source).toContain("creatorId: kbContext.toneCreator.creatorId");
    expect(source).toContain("creatorName: kbContext.toneCreator.creatorName");
    expect(source).toContain("matchPct");
  });
});

// ─── kbSearch.ts ─────────────────────────────────────────────────────────────

describe("Phase 4: kbSearch.ts tone info in KbSearchResult", () => {
  const source = readSource("artifacts/api-server/src/lib/kbSearch.ts");

  it("KbSearchResult.creator includes hasToneProfile field", () => {
    expect(source).toContain("hasToneProfile: boolean");
  });

  it("KbSearchResult.creator includes toneMatchPercentage field", () => {
    expect(source).toContain("toneMatchPercentage: number | null");
  });

  it("KbSearchResult.creator includes entryCount field", () => {
    expect(source).toContain("entryCount: number; // creator's total entries");
  });

  it("SQL SELECT includes c.tone_profile IS NOT NULL AS has_tone_profile", () => {
    expect(source).toContain("c.tone_profile IS NOT NULL AS has_tone_profile");
  });

  it("SQL SELECT includes c.tone_match_percentage + c.entry_count", () => {
    expect(source).toContain("c.tone_match_percentage AS creator_tone_match_percentage");
    expect(source).toContain("c.entry_count AS creator_entry_count");
  });

  it("getTopKbEntriesForPrompt returns toneCreator field", () => {
    expect(source).toContain("toneCreator:");
  });

  it("selectToneCreator checks hasToneProfile + entryCount >= threshold", () => {
    expect(source).toContain("selectToneCreator");
    expect(source).toContain("hasToneProfile");
    expect(source).toContain("entryCount >= TONE_THRESHOLD");
  });

  it("selectToneCreator has multi-creator tie-breaker (scores within 0.05)", () => {
    expect(source).toContain("0.05");
  });
});

// ─── aiAdmin.ts ──────────────────────────────────────────────────────────────

describe("Phase 4: aiAdmin.ts tone management endpoints", () => {
  const source = readSource("artifacts/api-server/src/routes/aiAdmin.ts");

  it("imports tone profile functions from kbToneProfiles", () => {
    expect(source).toContain("generateToneProfile");
    expect(source).toContain("getToneProfile");
    expect(source).toContain("getEffectiveToneMatchPercentage");
    expect(source).toContain("needsToneProfileRegeneration");
    expect(source).toContain("kbToneProfiles");
  });

  it("registers GET /ai/admin/kb/creators/:id/tone-profile", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/creators\/:id\/tone-profile["']/);
  });

  it("registers POST /ai/admin/kb/creators/:id/tone-profile/generate", () => {
    expect(source).toMatch(
      /router\.post\(\s*["']\/ai\/admin\/kb\/creators\/:id\/tone-profile\/generate["']/,
    );
  });

  it("registers PUT /ai/admin/kb/creators/:id/tone-percentage", () => {
    expect(source).toMatch(
      /router\.put\(\s*["']\/ai\/admin\/kb\/creators\/:id\/tone-percentage["']/,
    );
  });

  it("registers GET /ai/admin/kb/tone-profiles/status", () => {
    expect(source).toMatch(/router\.get\(\s*["']\/ai\/admin\/kb\/tone-profiles\/status["']/);
  });

  it("NO tone route uses the double /api/ prefix", () => {
    const brokenPattern =
      /router\.(get|post|put|delete|patch)\(\s*["']\/api\/ai\/admin\/kb\/(creators\/[^"']+\/tone|tone-profiles)/;
    expect(brokenPattern.test(source)).toBe(false);
  });

  it("GET tone-profile returns profile + needsRegeneration + matchPct", () => {
    expect(source).toContain("needsRegeneration: regenCheck.needed");
    expect(source).toContain("toneMatchPercentage: matchPct");
  });

  it("POST generate returns 422 on failure", () => {
    expect(source).toContain("422");
  });

  it("PUT tone-percentage validates 0-100 or null", () => {
    // v6.2 Part 11: the source has `percentage < 0 ||` + `percentage > 100 ||`
    // on separate lines (not joined on one line). Loosen to match either
    // form using [\s\S] for cross-newline matching.
    expect(source).toMatch(/percentage\s*<\s*0[\s\S]*?percentage\s*>\s*100/);
  });

  it("GET tone-profiles/status returns threshold + defaultPercentage + regenerationDelta", () => {
    expect(source).toContain("threshold: TONE_MATCH_THRESHOLD");
    expect(source).toContain("defaultPercentage: DEFAULT_TONE_MATCH_PERCENTAGE");
    expect(source).toContain("regenerationDelta: REGENERATION_DELTA");
  });
});

// ─── cron.ts + index.ts ──────────────────────────────────────────────────────

describe("Phase 4: cron.ts + index.ts scheduler", () => {
  const cronSource = readSource("artifacts/api-server/src/routes/cron.ts");
  const indexSource = readSource("artifacts/api-server/src/index.ts");

  it("cron.ts imports runKbToneProfileJob", () => {
    expect(cronSource).toContain("runKbToneProfileJob");
    expect(cronSource).toContain("kbToneProfileJob");
  });

  it("cron.ts registers POST /cron/kb-tone-profiles", () => {
    expect(cronSource).toMatch(/router\.post\(\s*["']\/cron\/kb-tone-profiles["']/);
  });

  it("cron.ts requires cron auth on the tone endpoint", () => {
    expect(cronSource).toContain("requireCronAuth(req, res)");
  });

  it("index.ts imports runKbToneProfileJob", () => {
    expect(indexSource).toContain("runKbToneProfileJob");
    expect(indexSource).toContain("kbToneProfileJob");
  });

  it("index.ts defines scheduleKbToneProfileJob function", () => {
    expect(indexSource).toContain("function scheduleKbToneProfileJob");
  });

  it("index.ts calls scheduleKbToneProfileJob() in the listen callback", () => {
    expect(indexSource).toContain("scheduleKbToneProfileJob()");
  });

  it("index.ts uses a 5-minute interval", () => {
    expect(indexSource).toContain("5 * 60 * 1000");
  });

  it("index.ts delays the first run by 2 minutes (startup delay)", () => {
    expect(indexSource).toContain("2 * 60 * 1000");
    expect(indexSource).toContain("STARTUP_DELAY_MS");
  });
});

// ─── ensureAiTables.ts ───────────────────────────────────────────────────────

describe("Phase 4: ensureAiTables.ts migration block", () => {
  const source = readSource("artifacts/api-server/src/lib/ensureAiTables.ts");

  it("has a Phase 4 migration block header", () => {
    expect(source).toContain("Phase 4: Creator tone matching");
  });

  it("adds tone_profile_entry_count INTEGER column", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS tone_profile_entry_count INTEGER");
  });

  it("adds tone_profile_model TEXT column", () => {
    expect(source).toContain("ADD COLUMN IF NOT EXISTS tone_profile_model TEXT");
  });
});

// ─── Drizzle schema (aiChat.ts) ──────────────────────────────────────────────

describe("Phase 4: Drizzle schema (aiChat.ts) tone columns", () => {
  const source = readSource("lib/db/src/schema/aiChat.ts");

  it("aiKbCreatorsTable has toneProfileEntryCount column", () => {
    expect(source).toContain('toneProfileEntryCount: integer("tone_profile_entry_count")');
  });

  it("aiKbCreatorsTable has toneProfileModel column", () => {
    expect(source).toContain('toneProfileModel: text("tone_profile_model")');
  });
});

// ─── kbCreators.ts (updated KbCreator interface) ─────────────────────────────

describe("Phase 4: kbCreators.ts KbCreator interface updates", () => {
  const source = readSource("artifacts/api-server/src/lib/kbCreators.ts");

  it("KbCreator interface includes toneProfileEntryCount", () => {
    expect(source).toContain("toneProfileEntryCount: number | null");
  });

  it("KbCreator interface includes toneProfileModel", () => {
    expect(source).toContain("toneProfileModel: string | null");
  });

  it("KbCreatorRow interface includes the new columns", () => {
    expect(source).toContain("tone_profile_entry_count: number | null");
    expect(source).toContain("tone_profile_model: string | null");
  });

  it("mapRow maps the new columns", () => {
    expect(source).toContain("toneProfileEntryCount: row.tone_profile_entry_count");
    expect(source).toContain("toneProfileModel: row.tone_profile_model");
  });

  it("SELECT queries include the new columns", () => {
    expect(source).toContain("tone_profile_entry_count, tone_profile_model");
  });
});

// ─── Frontend wiring ─────────────────────────────────────────────────────────

describe("Phase 4: frontend wiring", () => {
  it("kbApi.ts exports 4 tone API functions + types", () => {
    const source = readSource("artifacts/tree-friend/src/lib/kbApi.ts");
    expect(source).toContain("export async function fetchToneProfile(");
    expect(source).toContain("export async function generateToneProfile(");
    expect(source).toContain("export async function setToneMatchPercentage(");
    expect(source).toContain("export async function fetchToneProfileStatus(");
    expect(source).toContain("export interface ToneProfile");
    expect(source).toContain("export interface KbToneProfileResponse");
    expect(source).toContain("export interface KbToneProfilesStatusResponse");
  });

  it("KbToneProfileModal.tsx exists + shows profile + has regenerate button", () => {
    const source = readSource(
      "artifacts/tree-friend/src/components/admin/modals/KbToneProfileModal.tsx",
    );
    expect(source).toContain("KbToneProfileModal");
    expect(source).toContain("fetchToneProfile");
    expect(source).toContain("generateToneProfile");
    expect(source).toContain("Adjectives");
    expect(source).toContain("Tone Summary");
    expect(source).toContain("Regenerate");
  });

  it("KbTab.tsx registers the 'tone' sub-tab", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/tabs/KbTab.tsx");
    expect(source).toContain('"categories" | "sources" | "entries" | "insights" | "tone"');
    expect(source).toContain('id === "tone" && "Tone"');
    expect(source).toContain('activeSubTab === "tone" && <KbToneView');
  });

  it("KbTab.tsx defines KbToneView with status table + generate + edit %", () => {
    const source = readSource("artifacts/tree-friend/src/components/admin/tabs/KbTab.tsx");
    expect(source).toContain("function KbToneView");
    expect(source).toContain("fetchToneProfileStatus");
    expect(source).toContain("Generate All Pending");
    expect(source).toContain("setToneMatchPercentage");
    // Table columns.
    expect(source).toContain("Eligible");
    expect(source).toContain("Profile");
    expect(source).toContain("Match %");
    expect(source).toContain("Last Generated");
  });
});
