import { z } from "zod";

// Cost/tokens — values the harness reports in its own trace (e.g. Claude's total_cost_usd).
export const CostSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof CostSchema>;

// Normalized trace — every harness adapter converts its native output into "this".
// Every metric (task success/trajectory/cost/latency) derives from this single stream.
export const TraceEventSchema = z.discriminatedUnion("kind", [
  z.object({ t: z.number(), kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({
    t: z.number(),
    kind: z.literal("llm_call"),
    model: z.string(),
    cost: CostSchema.optional(),
    latencyMs: z.number().optional(),
  }),
  z.object({ t: z.number(), kind: z.literal("tool_call"), id: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ t: z.number(), kind: z.literal("tool_result"), id: z.string(), ok: z.boolean(), output: z.string() }),
  z.object({ t: z.number(), kind: z.literal("env_action"), action: z.string(), detail: z.unknown().optional() }),
  z.object({ t: z.number(), kind: z.literal("error"), message: z.string() }),
  // Raw process output (evidence fallback for black-box harnesses) — stderr progress logs and oversized stdout
  // that don't fit the message/tool vocabulary. Tail-capped by the emitter; judges/sinks may ignore it.
  z.object({ t: z.number(), kind: z.literal("log"), stream: z.enum(["stdout", "stderr"]), text: z.string() }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// Usage summary for one run — the sum of the trace's llm_call costs (exposed explicitly so the client doesn't parse the trace).
export const RunUsageSummarySchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(), // number of llm_call events
});
export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;

// The trace → usage derivation (usageFromTrace) lives in @everdict/domain (trace/) — re-architecture P1e.
