import { z } from "zod";

// Cost/tokens — values the harness reports in its own trace (e.g. Claude's total_cost_usd).
export const CostSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof CostSchema>;

// STRUCTURE — the optional shape every non-infra event may carry, so the stream can be read as the tree it
// came from instead of a flat list. All four are additive and optional: a harness that reports none produces
// exactly the stream it always did, and no judge/grader changes.
//
// Why they exist: our own ledger normalizes every source into this vocabulary, and until now that
// normalization DROPPED a span's identity and parentage — so an OTel trace read from the platform's own UI
// was a waterfall, while the same trace read from our store was a list. The renderer was never the problem;
// the model was. (`spanId`/`parentId` = the span tree; `durationMs` = how long the step took, not just when it
// started; `at` = the absolute instant, since `t` is relative to the EMITTER's clock.)
const STRUCTURE = {
  spanId: z.string().optional(), // this step's own id — the node a child points at
  parentId: z.string().optional(), // the enclosing step's spanId; absent = a root
  durationMs: z.number().optional(), // how long this step took (an instant when absent)
  at: z.string().optional(), // absolute wall-clock (ISO), when the emitter knows it
};

// ── AN OVERSIZED PAYLOAD IS MOVED, NOT LOST ──────────────────────────────────────────────────────────
//
// `artifact` has always been ref-only — `ref` is "a fetchable pointer, not the bytes". Nothing else was, and
// the fields that actually grow without bound on a long-horizon run are these: a tool result holding a file
// dump, a write_file call's arguments, an assistant message with a large code block, a captured stdout, and
// the attribute bag an OTLP exporter copied verbatim (the GenAI convention puts prompt and completion
// CONTENT in attributes). `offloadSnapshot` bounded an EnvSnapshot's screenshot and DOM years ago
// (`DOM_INLINE_MAX`); this is that same law applied where the bytes actually arrive.
//
// The shape is exactly `dom`/`domRef`: when `<x>Ref` is present the sibling field holds a PREVIEW and the
// full bytes are at the ref (`artifact://<key>`). A reader that only displays keeps the preview; a reader
// that judges asks the store to resolve (`TrajectoryWindow.resolve`), and the store puts the bytes back
// before anything projects or scores. Nothing is discarded — this is a move, and the record still contains
// what the agent produced.
//
// DELIBERATELY NOT offloaded: `error.message` (both harness adapters already tail-cap it at 2000) and
// `env_action.detail` (a small structured value). A ref costs a fetch; adding one to a field that does not
// grow buys nothing and gives every consumer a second case to handle.
const OFFLOAD_REF = (field: string) =>
  z.string().optional().describe(`artifact:// ref to the full ${field}; when present, ${field} holds a preview`);

// Normalized trace — every harness adapter converts its native output into "this".
// Every metric (task success/trajectory/cost/latency) derives from this single stream.
export const TraceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    t: z.number(),
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    textRef: OFFLOAD_REF("text"),
    ...STRUCTURE,
  }),
  z.object({
    t: z.number(),
    kind: z.literal("llm_call"),
    model: z.string(),
    cost: CostSchema.optional(),
    latencyMs: z.number().optional(),
    ...STRUCTURE,
  }),
  z.object({
    t: z.number(),
    kind: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    args: z.unknown(),
    argsRef: OFFLOAD_REF("args"),
    ...STRUCTURE,
  }),
  z.object({
    t: z.number(),
    kind: z.literal("tool_result"),
    id: z.string(),
    ok: z.boolean(),
    output: z.string(),
    outputRef: OFFLOAD_REF("output"),
    ...STRUCTURE,
  }),
  z.object({
    t: z.number(),
    kind: z.literal("env_action"),
    action: z.string(),
    detail: z.unknown().optional(),
    ...STRUCTURE,
  }),
  z.object({ t: z.number(), kind: z.literal("error"), message: z.string(), ...STRUCTURE }),
  // Raw process output (evidence fallback for black-box harnesses) — stderr progress logs and oversized stdout
  // that don't fit the message/tool vocabulary. Tail-capped by the emitter; judges/sinks may ignore it.
  z.object({
    t: z.number(),
    kind: z.literal("log"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
    textRef: OFFLOAD_REF("text"),
    ...STRUCTURE,
  }),
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
    ...STRUCTURE,
  }),
  // A structural (non-LLM/non-tool) span preserved through ingest — chain/agent/retriever steps a harness emits that
  // the GenAI-convention normalizer would otherwise drop. `attributes` carries the raw span attributes verbatim.
  // `durationMs` is the span's own length when the source reported one (OTLP end−start): without it a service's
  // spans arrive as instants and a cross-plane timeline can only draw where they STARTED, not what they cost.
  z.object({
    t: z.number(),
    kind: z.literal("span"),
    name: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    // The WHOLE bag moves, not one key: a page cannot know which attribute a projection will read, and
    // offloading them one at a time would leave the bag half-resolved with nothing saying so.
    attributesRef: OFFLOAD_REF("attributes"),
    ...STRUCTURE, // `durationMs` lives here now — it was this kind's field first, and every kind needs it
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
    // STRUCTURE carries this plane's `at` — the absolute wall-clock the cross-plane axis aligns on (`t` is
    // relative to the EMITTER's clock: dispatch t0 for infra vs in-job t0 for agent events). It was declared
    // here first; every kind has it now.
    ...STRUCTURE,
  }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// When an event happened, stamped BOTH ways — what every emitter of this stream owes a reader.
//
// `t` stays exactly what it always was: the emitter's own scalar, whose unit only that emitter knows (a step
// index here, ms since dispatch there, epoch ms in a harness that reads the wall clock). Graders read its
// SPAN, which is unit-agnostic. `at` is the addition, and the only field a reader can lay on a shared axis.
//
// Why it is not optional in practice: without `at`, a reader has to guess `t`'s unit, and guessing "milliseconds
// from whatever anchor is nearby" is how a self-reported trace numbered 1,2,3… once drew fifteen agent steps
// inside the first fifteen MILLISECONDS of a twenty-three second run. An event that carries `at` cannot be
// misread that way, whatever its `t` counts.
export function stamp(now: () => number): { t: number; at?: string } {
  const ms = now();
  if (!Number.isFinite(ms)) return { t: ms };
  try {
    return { t: ms, at: new Date(ms).toISOString() };
  } catch {
    // A clock outside the Date range is still a usable ordinal — the event keeps `t` and stays off the axis.
    return { t: ms };
  }
}

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
