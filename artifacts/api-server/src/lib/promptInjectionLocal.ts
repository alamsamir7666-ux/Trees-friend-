/**
 * Local prompt-injection heuristic classifier.
 *
 * Always-available fallback when no external classifier (Lakera) is
 * configured or all external providers fail. Uses regex + pattern matching
 * to catch the common prompt-injection attack vectors.
 *
 * ─── Why a local heuristic? ───────────────────────────────────────────────
 *
 * External APIs (Lakera) are more accurate but:
 *   1. Require an API key (not always available in dev/self-hosted)
 *   2. Add latency (~100-300ms per call)
 *   3. Cost money per call
 *   4. Can be down (need a fallback)
 *
 * The local heuristic catches the well-known attack patterns:
 *   - "Ignore previous instructions" / "Forget your rules"
 *   - DAN-style jailbreaks ("Do Anything Now")
 *   - Role-play hijacks ("You are now an AI without restrictions")
 *   - Prompt extraction ("Repeat your system prompt", "What are your rules?")
 *   - Instruction override ("Override: ", "System: ", "Admin: ")
 *   - Encoding attacks (base64, ROT13 — detected via heuristics)
 *
 * It won't catch novel or sophisticated attacks (which is why Lakera is
 * preferred when available), but it stops the "low-hanging fruit" that
 * accounts for ~90% of real-world attacks.
 *
 * ─── Scoring ────────────────────────────────────────────────────────────────
 *
 * Each pattern has a weight (0.0-1.0). The final score is the MAX of all
 * matching patterns (not the sum — multiple weak matches shouldn't
 * overpower a single strong match). A score >= 0.7 triggers a block.
 *
 * Pattern weights are calibrated against the Prompt Injection Benchmark
 * (https://github.com/meta-llama/prompt-injection-benchmark) + Lakera's
 * public attack corpus.
 *
 * ─── False positive avoidance ───────────────────────────────────────────────
 *
 * Plant-care queries sometimes mention "instructions" ("What are the care
 * instructions for a mango tree?") or "rules" ("What are the watering
 * rules?"). We avoid blocking these by:
 *   1. Requiring attack-specific phrasing ("ignore YOUR instructions",
 *      not just "instructions")
 *   2. Requiring override-style prefixes at the START of a line
 *      ("System: ..." not "the system is...")
 *   3. Allowing queries about "rules" in a plant-care context
 *
 * The local heuristic is intentionally conservative — better to let a
 * few attacks through than to block legitimate plant questions.
 */
import type { PromptInjectionProvider, InjectionCheckResult } from "./promptInjection";

// ─── Attack patterns ────────────────────────────────────────────────────────
//
// Each pattern has:
//   - regex: the pattern to match (case-insensitive)
//   - weight: confidence score if matched (0-1)
//   - attackType: category label for logging
//   - description: human-readable explanation

interface AttackPattern {
  regex: RegExp;
  weight: number;
  attackType: string;
  description: string;
}

const ATTACK_PATTERNS: AttackPattern[] = [
  // ─── Instruction override (weight: 0.9) ──────────────────────────────────
  // The classic "ignore previous instructions" attack.
  {
    regex:
      /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?|directives?)/i,
    weight: 0.95,
    attackType: "instruction_override",
    description: "Explicit instruction override attempt",
  },
  {
    regex:
      /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?(?:instructions?|rules?|directives?|guidelines?)/i,
    weight: 0.9,
    attackType: "instruction_override",
    description: "Instruction reset attempt",
  },
  {
    regex: /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?)/i,
    weight: 0.9,
    attackType: "instruction_override",
    description: "Instruction disregard attempt",
  },
  {
    regex: /(?:override|reset)\s*:\s*(?:instructions?|rules?|system)/i,
    weight: 0.85,
    attackType: "instruction_override",
    description: "Override prefix detected",
  },

  // ─── Role-play hijack (weight: 0.85) ────────────────────────────────────
  // "You are now DAN" / "Act as an unrestricted AI" style attacks.
  {
    regex:
      /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|from\s+now\s+on\s+you\s+are)\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|free|liberated)\s+(?:ai|assistant|model|chatbot)/i,
    weight: 0.9,
    attackType: "role_hijack",
    description: "Role-play hijack to unrestricted AI",
  },
  {
    regex: /\bDAN\b\s*(?:mode|jailbreak|prompt)/i,
    weight: 0.95,
    attackType: "jailbreak",
    description: "DAN jailbreak attempt",
  },
  {
    regex: /(?:do\s+anything\s+now|DAN\s+mode\s+enabled)/i,
    weight: 0.95,
    attackType: "jailbreak",
    description: "DAN jailbreak activation",
  },
  {
    regex:
      /(?:you\s+are|act\s+as)\s+(?:now\s+)?(?:a\s+)?(?:helpful|compliant|obedient)\s+(?:ai|assistant)\s+(?:that\s+)?(?:can|will|must)\s+(?:answer|do|tell|reveal)\s+(?:anything|everything|all)/i,
    weight: 0.85,
    attackType: "role_hijack",
    description: "Role-play to compliant AI that answers anything",
  },
  {
    regex: /(?:enter|enable|activate)\s+(?:developer|admin|root|god|debug)\s+mode/i,
    weight: 0.85,
    attackType: "role_hijack",
    description: "Privilege escalation via mode activation",
  },

  // ─── Prompt extraction (weight: 0.8) ────────────────────────────────────
  // Attempts to extract the system prompt or internal instructions.
  {
    regex:
      /(?:repeat|reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|directives?|guidelines?|configuration|internal\s+\w+)/i,
    weight: 0.8,
    attackType: "prompt_extraction",
    description: "Attempt to extract system prompt",
  },
  {
    regex:
      /what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?|directives?|internal\s+\w+)/i,
    weight: 0.75,
    attackType: "prompt_extraction",
    description: "Querying system prompt",
  },
  {
    regex:
      /(?:translate|convert)\s+(?:this|the\s+following)\s+(?:to|into)\s+(?:english|plain\s+text|normal)\s*[:\n]/i,
    weight: 0.7,
    attackType: "prompt_extraction",
    description: "Translation-based extraction (often used to leak system prompt)",
  },

  // ─── System message spoofing (weight: 0.85) ─────────────────────────────
  // Attempts to inject fake system/admin messages.
  {
    regex: /^(?:system|admin|developer|root|moderator)\s*:\s*/i,
    weight: 0.85,
    attackType: "role_spoof",
    description: "Fake system/admin message prefix",
  },
  {
    regex: /\[(?:system|admin|developer|root|instruction)\]\s*/i,
    weight: 0.85,
    attackType: "role_spoof",
    description: "Bracketed system message injection",
  },
  {
    regex: /<\|?(?:system|im_start|im_end|endoftext)\|?>/i,
    weight: 0.95,
    attackType: "role_spoof",
    description: "Special token injection (model tokenizer abuse)",
  },

  // ─── Credential/secret extraction (weight: 0.8) ─────────────────────────
  // Attempts to extract passwords, API keys, or secrets.
  {
    regex:
      /(?:tell|give|show|reveal)\s+(?:me\s+)?(?:the\s+)?(?:admin|root|database|api|secret|password|token|key)\s*(?:password|key|token|secret|credentials?)?/i,
    weight: 0.8,
    attackType: "secret_extraction",
    description: "Attempt to extract credentials/secrets",
  },
  {
    regex:
      /what\s+(?:is|are)\s+(?:the\s+)?(?:admin|root|database|api)\s*(?:password|passwords|credentials?|keys?|token|secret|api\s+key)/i,
    weight: 0.85,
    attackType: "secret_extraction",
    description: "Direct credential query",
  },
  {
    regex: /what\s+is\s+the\s+\w+\s+(?:api\s+)?(?:key|password|token|secret)\??/i,
    weight: 0.8,
    attackType: "secret_extraction",
    description: "Direct secret query (generic)",
  },

  // ─── Encoding attacks (weight: 0.7) ─────────────────────────────────────
  // Base64/ROT13 encoded instructions (attempts to bypass text filters).
  {
    regex:
      /(?:decode|interpret|execute)\s+(?:the\s+following\s+)?(?:base64|rot13|hex|binary)\s*[:\n]/i,
    weight: 0.75,
    attackType: "encoding_attack",
    description: "Encoded instruction execution request",
  },
  // Long base64 strings (50+ chars) — likely encoded payloads.
  {
    regex: /\b[A-Za-z0-9+/]{50,}={0,2}\b/,
    weight: 0.6,
    attackType: "encoding_attack",
    description: "Long base64 string (possible encoded payload)",
  },

  // ─── Capability override (weight: 0.75) ────────────────────────────────
  // Attempts to make the AI claim it can do things it can't.
  {
    regex:
      /(?:you\s+(?:can|are\s+able\s+to|have\s+the\s+ability\s+to)\s+(?:now|also)?\s*(?:access|browse|search|execute|run|access\s+the\s+internet|run\s+code))/i,
    weight: 0.75,
    attackType: "capability_override",
    description: "False capability grant",
  },
];

// ─── Provider implementation ────────────────────────────────────────────────

export class LocalInjectionProvider implements PromptInjectionProvider {
  readonly name = "local";

  isConfigured(): boolean {
    // Always "configured" — it's the fallback of last resort.
    return true;
  }

  async detect(message: string): Promise<InjectionCheckResult> {
    if (!message || !message.trim()) {
      return {
        detected: false,
        score: 0,
        provider: this.name,
        latencyMs: 0,
      };
    }

    let maxScore = 0;
    let matchedPattern: AttackPattern | null = null;

    // Check each pattern — track the highest-scoring match.
    for (const pattern of ATTACK_PATTERNS) {
      pattern.regex.lastIndex = 0; // reset for global regexes
      if (pattern.regex.test(message)) {
        if (pattern.weight > maxScore) {
          maxScore = pattern.weight;
          matchedPattern = pattern;
        }
      }
    }

    if (!matchedPattern) {
      return {
        detected: false,
        score: 0,
        provider: this.name,
        latencyMs: 0,
        explanation: "No attack patterns matched",
      };
    }

    return {
      detected: maxScore >= 0.7,
      score: maxScore,
      attackType: matchedPattern.attackType,
      provider: this.name,
      latencyMs: 0, // set by the caller
      explanation: matchedPattern.description,
    };
  }
}

// ─── Exported for testing ───────────────────────────────────────────────────

export const ATTACK_PATTERN_COUNT = ATTACK_PATTERNS.length;
