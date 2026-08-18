/**
 * diagnose-models.ts — query Groq + Gemini for their actual available models.
 *
 * USAGE (on the production server where env vars are set):
 *
 *   cd /opt/render/project/src  # or wherever the repo is checked out
 *   npx tsx scripts/diagnose-models.ts
 *
 * OR locally with env vars exported:
 *
 *   GROQ_API_KEY=gsk_xxx GEMINI_API_KEY=AIzaXxx npx tsx scripts/diagnose-models.ts
 *
 * The script queries both providers' /models endpoints and prints:
 *   - Which models are actually available on your account
 *   - Which ones support function/tool calling (the ones we need)
 *   - Recommended replacements for the broken model chain
 *
 * Paste the output back to the chat + I'll update groq.ts + gemini.ts with
 * the correct model names.
 */
import process from "node:process";

// ─── Groq ────────────────────────────────────────────────────────────────────

interface GroqModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  active: boolean;
  context_window?: number;
  // Groq's /models response includes these fields when the model supports them:
  supports_tool_calling?: boolean;
  supports_vision?: boolean;
  supports_response_format?: boolean;
}

async function diagnoseGroq(): Promise<void> {
  const key = process.env.GROQ_API_KEY;
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("GROQ DIAGNOSTIC");
  console.log("════════════════════════════════════════════════════════════════");
  if (!key) {
    console.log("⚠ GROQ_API_KEY is not set — skipping Groq diagnostic.");
    return;
  }
  console.log(`✓ GROQ_API_KEY is set (${key.slice(0, 8)}...${key.slice(-4)})`);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`✗ Groq /models returned ${res.status}: ${text}`);
      return;
    }
    const data = (await res.json()) as { data: GroqModel[] };
    const models = data.data.filter((m) => m.active).sort((a, b) => a.id.localeCompare(b.id));

    console.log(`\n✓ ${models.length} active models on your account:`);

    // Group by family.
    const families = new Map<string, GroqModel[]>();
    for (const m of models) {
      const family = m.id.split("-")[0]; // "llama", "gemma", "mixtral", etc.
      let fam = families.get(family);
      if (!fam) {
        fam = [];
        families.set(family, fam);
      }
      fam.push(m);
    }

    for (const [family, famModels] of families) {
      console.log(`\n  ${family.toUpperCase()} family:`);
      for (const m of famModels) {
        const ctx = m.context_window ? `${Math.round(m.context_window / 1000)}K ctx` : "";
        const tools = m.supports_tool_calling ? "tools✓" : "";
        const vision = m.supports_vision ? "vision✓" : "";
        const flags = [ctx, tools, vision].filter(Boolean).join(" ");
        console.log(`    ${m.id}${flags ? `  (${flags})` : ""}`);
      }
    }

    // Recommend models that support tool calling (what we need).
    const toolCapable = models.filter((m) => m.supports_tool_calling);
    if (toolCapable.length > 0) {
      console.log(`\n→ Models with tool/function-calling support (${toolCapable.length}):`);
      for (const m of toolCapable) {
        console.log(`    • ${m.id}`);
      }
    } else {
      console.log("\n⚠ No models explicitly advertise tool_calling support.");
      console.log("  Most Groq llama-* and mixtral-* models support tool calling");
      console.log("  even when not flagged — try one and it'll likely work.");
    }
  } catch (err) {
    console.log(`✗ Groq diagnostic failed: ${(err as Error).message}`);
  }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

interface GeminiModel {
  name: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
  inputTokenLimit: number;
  outputTokenLimit: number;
}

async function diagnoseGemini(): Promise<void> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("GEMINI DIAGNOSTIC");
  console.log("════════════════════════════════════════════════════════════════");
  if (!key) {
    console.log("⚠ GEMINI_API_KEY (or GOOGLE_API_KEY) is not set — skipping Gemini diagnostic.");
    return;
  }
  console.log(`✓ GEMINI_API_KEY is set (${key.slice(0, 8)}...${key.slice(-4)})`);

  try {
    // ListModels endpoint — v1beta includes newer models.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      console.log(`✗ Gemini ListModels returned ${res.status}: ${text}`);
      return;
    }
    const data = (await res.json()) as { models: GeminiModel[] };
    const models = (data.models ?? []).sort((a, b) => a.name.localeCompare(b.name));

    console.log(`\n✓ ${models.length} models available:`);

    // Filter to models that support generateContent (chat) + filter out
    // embedding / vision-only models.
    const chatModels = models.filter((m) =>
      m.supportedGenerationMethods?.includes("generateContent"),
    );
    console.log(`  (${chatModels.length} support generateContent for chat):`);

    for (const m of chatModels) {
      const ctx = `${Math.round(m.inputTokenLimit / 1000)}K ctx`;
      const out = `${Math.round(m.outputTokenLimit / 1000)}K out`;
      console.log(`    ${m.name}  (${ctx}, ${out})  — ${m.displayName}`);
    }

    // Gemini's tool support is via generateContent (same list above).
    // No separate filter needed — the list already shows all chat-capable
    // models. Function calling is supported on all current gemini-*-flash
    // and gemini-*-pro models that expose generateContent.
  } catch (err) {
    console.log(`✗ Gemini diagnostic failed: ${(err as Error).message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("TreeFriend AI Provider Diagnostic");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);

  await diagnoseGroq();
  await diagnoseGemini();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("DONE — paste the output above back to the chat.");
  console.log("════════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err);
  process.exit(1);
});
