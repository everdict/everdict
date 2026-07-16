import { z } from "zod";

// POST /models/test-connection 200 — outcome of a live dummy completion against a model's resolved connection
// (provider + underlying model + baseUrl + resolved apiKeySecret value). A reachable, correctly-responding model
// returns ok:true with the response text preview; any failure (missing secret, upstream 4xx/5xx, network) returns
// ok:false with a human-readable reason. Never a 4xx — the probe outcome is the payload, so the UI shows it inline.
export const TestModelConnectionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    provider: z.string().describe("Model provider used for the probe (anthropic | openai)"),
    model: z.string().describe("Underlying model identifier the probe called"),
    text: z.string().describe("The model's response text (preview of what a real call returns)"),
    latencyMs: z.number().int().nonnegative().describe("Round-trip latency of the probe call"),
  }),
  z.object({
    ok: z.literal(false),
    provider: z.string(),
    model: z.string(),
    error: z.string().describe("Why the probe failed (missing secret, upstream status, network error)"),
  }),
]);
export type TestModelConnectionResult = z.infer<typeof TestModelConnectionResultSchema>;
