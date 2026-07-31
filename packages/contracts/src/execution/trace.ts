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
  // A produced artifact (file/attachment the agent emitted) — `ref` is a fetchable pointer (URL/path), not the bytes.
  // The ingest-generalization channel: platforms that carry attachments surface them here so an `artifact` judge
  // requirement is satisfiable. Judges/sinks that don't need it may ignore it. `role` = the artifact's purpose (e.g. "report").
  z.object({
    t: z.number(),
    kind: z.literal("artifact"),
    name: z.string(),
    ref: z.string(),
    mediaType: z.string().optional(),
    role: z.string().optional(),
  }),
  // A structural (non-LLM/non-tool) span preserved through ingest — chain/agent/retriever steps a harness emits that
  // the GenAI-convention normalizer would otherwise drop. `attributes` carries the raw span attributes verbatim.
  // `durationMs` is the span's own length when the source reported one (OTLP end−start): without it a service's
  // spans arrive as instants and a cross-plane timeline can only draw where they STARTED, not what they cost.
  z.object({
    t: z.number(),
    kind: z.literal("span"),
    name: z.string(),
    durationMs: z.number().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  }),
  // The INFRA-plane record of the run's execution — the orchestrator's own account (job submission, blocked
  // placement verdicts, task/pod lifecycle events, restarts, OOM kills; a service topology's per-unit state).
  // Appended by the BACKEND, the only layer that sees it, so the record survives the cluster's job GC and rides
  // the sealed trajectory. scope "placement" = the case's own unit; "service" = a topology unit the run drives.
  // Judges/sinks may ignore it (same contract as `log`).
  z.object({
    t: z.number(),
    kind: z.literal("infra"),
    scope: z.enum(["placement", "service"]),
    event: z.string().optional(), // orchestrator event type ("Started", "Driver Failure", "blocked", …)
    message: z.string(),
    unit: z.string().optional(), // alloc id / pod name
    node: z.string().optional(),
    service: z.string().optional(), // the topology unit's name (scope "service")
    // Absolute wall-clock (ISO) when the emitter knows it — the cross-plane alignment anchor: `t` is relative
    // to the EMITTER's clock (dispatch t0 for infra vs in-job t0 for agent events), `at` is absolute.
    at: z.string().optional(),
  }),
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
