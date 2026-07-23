// Live smoke for @everdict/llm's provider-native transports — exercises complete() (one-shot) + stream() (token
// deltas) against a REAL endpoint, so the wire format (message protocol, tool serialization, usage normalization incl.
// cache tokens) is verified end-to-end, not just mocked.
//
// everdict is provider-NATIVE (not agnostic-over-LiteLLM): pick the provider explicitly.
//   provider "anthropic"        → native Anthropic Messages API (needs ANTHROPIC_API_KEY)
//   provider "openai"           → native OpenAI Chat Completions (needs OPENAI_API_KEY)
//   provider "openai-compatible" → any OpenAI-shaped endpoint (vLLM / a LiteLLM proxy) via LLM_SMOKE_BASE_URL
//
// Env: LLM_SMOKE_PROVIDER (default openai-compatible), LLM_SMOKE_KEY, LLM_SMOKE_BASE_URL (compatible only),
//   LLM_SMOKE_MODEL. Skips (exit 0) if the key is unset. Example (dev LiteLLM):
//   LLM_SMOKE_PROVIDER=openai-compatible LLM_SMOKE_BASE_URL=http://localhost:4000/v1 \
//   LLM_SMOKE_KEY=sk-... LLM_SMOKE_MODEL=chatgpt/gpt-5.4-mini node scripts/live/llm-transport.mjs
import process from "node:process";
import { transportFor } from "../../packages/llm/dist/index.js";

const provider = process.env.LLM_SMOKE_PROVIDER ?? "openai-compatible";
const apiKey = process.env.LLM_SMOKE_KEY;
const baseUrl = process.env.LLM_SMOKE_BASE_URL;
const model = process.env.LLM_SMOKE_MODEL;

if (!apiKey || !model) {
  console.log("SKIP: set LLM_SMOKE_KEY + LLM_SMOKE_MODEL (+ LLM_SMOKE_BASE_URL for openai-compatible).");
  process.exit(0);
}

const transport = transportFor({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
const req = {
  model,
  system: "You answer in one short word.",
  messages: [{ role: "user", content: "Say the word: ping" }],
  tools: [],
  maxTokens: 4096,
  cache: { system: true, tools: true },
};

console.log(`provider: ${transport.provider}  model: ${model}`);

const c = await transport.complete(req);
console.log("complete():", JSON.stringify({ content: c.content, finishReason: c.finishReason, usage: c.usage }));

let streamed = "";
const s = await transport.stream({
  ...req,
  onContentDelta: (d) => {
    streamed += d;
  },
});
console.log(
  "stream():",
  JSON.stringify({ content: s.content, deltas: streamed.length, finishReason: s.finishReason, usage: s.usage }),
);

if (!c.content || !s.content) {
  console.error("FAIL: empty content from complete() or stream()");
  process.exit(1);
}
console.log("LIVE SMOKE PASS");
