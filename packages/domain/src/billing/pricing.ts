// Best-effort per-model USD pricing — for cost we can't read from a provider trace. A harness reports its own
// total_cost_usd (the trace's llm_call.cost.usd), but the agent loop yields TOKENS only, so the meter needs a price
// table to turn agent-conversation tokens into a USD figure. These are APPROXIMATE public list prices (USD per 1M
// tokens) as of the 2026-01 knowledge cutoff — an operator should treat agent USD as an estimate; the token counts are
// exact. Matched by a lowercase substring so version suffixes (…-4-8 / …-20251001) still resolve; an unknown model
// prices to $0 (its tokens are still metered, itemized per model). docs/architecture/usage-metering.md
interface ModelPrice {
  match: string; // case-insensitive substring of the underlying model string
  inputPer1M: number;
  outputPer1M: number;
  // Prompt-cache token rates. Absent → cache tokens price at the plain input rate (correct for providers/models
  // whose cache pricing we don't know; their transports usually report no cache split anyway).
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

// Order matters: a more specific match (e.g. "gpt-4o-mini") must precede its broader prefix ("gpt-4o") since the
// first substring hit wins. Anthropic cache rates: read = 0.1x input, write (5m TTL) = 1.25x input. OpenAI: cached
// input at half rate, no write charge (its transport never reports cacheWriteTokens).
const MODEL_PRICES: readonly ModelPrice[] = [
  { match: "opus", inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 }, // Anthropic Claude Opus tier
  { match: "sonnet", inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 }, // Claude Sonnet tier
  { match: "haiku", inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08, cacheWritePer1M: 1 }, // Claude Haiku tier
  { match: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 },
  { match: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 },
];

// USD for a token count on a given model — $0 when the model isn't in the (approximate) price table. Transports fold
// cache tokens INTO inputTokens (the full prompt footprint), so the cached share is subtracted here and re-priced at
// its own rate — without the split, every cached read would bill at the full input price.
export function priceUsd(
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const m = model.toLowerCase();
  const price = MODEL_PRICES.find((p) => m.includes(p.match));
  if (!price) return 0;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(tokens.inputTokens - cacheRead - cacheWrite, 0);
  return (
    (uncachedInput * price.inputPer1M +
      cacheRead * (price.cacheReadPer1M ?? price.inputPer1M) +
      cacheWrite * (price.cacheWritePer1M ?? price.inputPer1M) +
      tokens.outputTokens * price.outputPer1M) /
    1_000_000
  );
}
