export interface TokenBudget {
  maxTokens: number;
  consumed: number;
}

export function thresholdReached(b: TokenBudget, threshold = 0.9): boolean {
  return b.maxTokens > 0 && b.consumed >= b.maxTokens * threshold;
}

// Known context windows (tokens), matched by case-insensitive substring so provider prefixes/suffixes still resolve
// (e.g. "anthropic/claude-opus-4-8", "chatgpt/gpt-5.4-mini"). Order matters — more specific matches first.
const CONTEXT_WINDOWS: { match: string; window: number }[] = [
  { match: "gpt-4.1", window: 1_000_000 },
  { match: "gpt-5", window: 400_000 },
  { match: "gpt-4o", window: 128_000 },
  { match: "gpt-4", window: 128_000 },
  { match: "o3", window: 200_000 },
  { match: "o1", window: 200_000 },
  { match: "opus", window: 200_000 },
  { match: "sonnet", window: 200_000 },
  { match: "haiku", window: 200_000 },
  { match: "claude", window: 200_000 },
  { match: "gemini", window: 1_000_000 },
];
const DEFAULT_CONTEXT_WINDOW = 128_000;
// Reserve headroom for the model's own output + the compaction summary, so the loop compacts BEFORE the window is full.
const OUTPUT_RESERVE_TOKENS = 32_000;

export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  for (const { match, window } of CONTEXT_WINDOWS) if (m.includes(match)) return window;
  return DEFAULT_CONTEXT_WINDOW;
}

// The token budget for a model = its context window minus output headroom (the loop compacts at ~90% of this). Replaces
// the old fixed 900k, which was one model's number treated as a constant.
export function effectiveBudget(model: string, reserve = OUTPUT_RESERVE_TOKENS): number {
  return Math.max(contextWindowFor(model) - reserve, reserve);
}

// Rough token estimate (bytes/4 for text, a flat cost per image block) — the "estimate" half of hybrid budgeting: the
// model's reported usage covers only the messages it saw, so tool results appended AFTER its turn are estimated on top.
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_COST = 1_500;

export function estimateTokens(messages: readonly { content?: unknown }[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part === null || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string };
        if (p.type === "image_url") images += 1;
        else if (typeof p.text === "string") chars += p.text.length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_COST;
}
