import { z } from "zod";
import { ARTIFACT_REF_SCHEME } from "../artifact-ref.js";

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

// ── THE PRODUCER-FACING SCHEMA IS NOT THE STORED ONE (arch-review 121) ───────────────────────────────
//
// The `…Ref` fields above are an artifact COORDINATE: the platform mints them when it offloads an oversized
// payload, and both readers act on them — a resolve fetches that key from object storage, retention deletes
// it. They are therefore a capability, and `TraceEventSchema` is also what every producer's submission is
// validated by: a job result posted by a runner, a leased runner's event batch, trace JSON handed to a judge
// tool, a scorecard ingest, the front door's inline trace, and the output of the very harness under
// evaluation.
//
// So a producer could author a coordinate the platform would then act on — reading bytes it does not own into
// its own evidence, and having them deleted when its trajectory expired. Rule `protocol` already states the
// shape from `CaseResult`'s GC coordinate one review earlier: **the untrusted execution surface, the
// canonical measurement, and the platform's private lifecycle state are three schemas.** This is the second
// time that law has been paid for, and the first time it is expressed as a type.
//
// STRIP rather than reject, deliberately. Reading a trajectory back and feeding it to a judge is a real
// workflow, and those events legitimately carry the refs WE wrote; refusing them would break a caller for
// echoing our own output. Dropping the field is total, needs no error path, and leaves the value itself —
// the preview, or the whole payload for anything that was never offloaded — exactly as sent.
//
// The stripped names are derived from nothing: they are listed once, here, beside the fields they name.
// The coordinate fields, listed once beside the fields they name. `screenshotRef`/`domRef` are the same shape
// one document up: `EnvSnapshot` carries them, the platform mints them in `offloadSnapshot`, and the read
// path re-signs them into a browser-facing presigned URL — so a producer naming a key would be handed a
// signed URL for it, and the artifact bucket is ONE bucket for the deployment (arch-review 121).
const PLATFORM_AUTHORED_REF_FIELDS = [
  "textRef",
  "argsRef",
  "outputRef",
  "attributesRef",
  "screenshotRef",
  "domRef",
] as const;

// ── AND THE SIZES THAT DECIDE A BUDGET (arch-review 124) ────────────────────────────────────────────
//
// The offload records how big the object behind each ref is, so a resolved page can refuse an oversized
// payload BEFORE fetching it. That number decides whether bytes are read into a shared process, which makes
// it a capability in exactly the sense the refs are: a producer that could write `outputRefBytes: 1` would
// have every page fetch its payload whatever the real size.
//
// Stripped UNCONDITIONALLY — unlike the refs, there is no legitimate producer meaning for these at all, so
// there is no residue to reason about.
const PLATFORM_AUTHORED_SIZE_FIELDS = ["textRefBytes", "argsRefBytes", "outputRefBytes", "attributesRefBytes"] as const;

// ⚠️ THE RULE IS THE SCHEME, NOT THE FIELD NAME. `artifact://` is OUR handle over OUR object store, and that
// is the only thing a producer may not author. `os-use` legitimately reports where it captured a screenshot
// INSIDE the compute (`/tmp/shot.png`), which names nothing of ours — `publicUrlFor` already ignores it, and
// deleting it would throw away a producer's own report to fix a problem it is not part of.
export function stripPlatformAuthoredFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPlatformAuthoredFields);
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of PLATFORM_AUTHORED_REF_FIELDS) {
    const held = copy[field];
    if (typeof held === "string" && held.startsWith(ARTIFACT_REF_SCHEME)) delete copy[field];
  }
  for (const field of PLATFORM_AUTHORED_SIZE_FIELDS) delete copy[field];
  // Nested: `CaseResult` carries a snapshot and a whole trace, so the walk has to reach them.
  for (const [key, item] of Object.entries(copy))
    if (item !== null && typeof item === "object") copy[key] = stripPlatformAuthoredFields(item);
  return copy;
}

// What every UNTRUSTED door parses with. Same events, same validation — the platform's coordinates removed
// before they are read, so a producer cannot hand us one.
export const UntrustedTraceEventSchema = z.preprocess(stripPlatformAuthoredFields, TraceEventSchema);

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
