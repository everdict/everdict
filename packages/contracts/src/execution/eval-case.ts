import { z } from "zod";
import { CaseFailureSchema } from "./case-failure.js";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { RecordingRefSchema } from "./recording.js";
import { SpanAttrMappingSchema, TraceEvidenceSchema } from "./trace-source.js";
import { TraceEventSchema } from "./trace.js";
import { MetricAuthoritySchema } from "./verdict-policy.js";

// Grader spec: id + optional config (e.g. tests-pass's { cmd }).
// The agent reconstructs a Grader instance from this spec.
export const GraderSpecSchema = z.object({
  id: z.string(),
  config: z.record(z.unknown()).optional(),
  // The metric semantics this run-time grader DECLARES for the metric sharing its id — composed into the
  // batch's verdict policy at submit (composeVerdictPolicy), so a custom grader gains authority by DECLARING
  // it, never by a domain-code edit. A ground_truth declaration is constitution-gated (admin-only at submit):
  // whoever can name new ground truth can decide what passing MEANS, and that power is reviewed, not ambient.
  authority: MetricAuthoritySchema.optional(),
  direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

// The worlds an evaluation can declare. One vocabulary for the case's placement hint, the driver's
// ComputeSpec, the os-<x> placement capabilities and the execution manifest below.
export const PlacementOsSchema = z.enum(["linux", "windows", "macos"]);
export type PlacementOs = z.infer<typeof PlacementOsSchema>;

// Placement hint — the control-plane router reads it when deciding which backend to send to.
// The agent ignores this field (where it runs is not the agent's concern).
export const PlacementSchema = z.object({
  target: z.string().optional(), // registered backend name (e.g. "nomad-seoul")
  os: PlacementOsSchema.optional(),
  isolation: z.string().optional(), // e.g. "gvisor"
});
export type Placement = z.infer<typeof PlacementSchema>;

// The world every lane falls back to when nobody declared one. Named, not inlined, so the decision has
// exactly ONE definition instead of a `?? "linux"` scattered across the drivers, the topology builders and
// the capability derivation — each of which used to make it privately and silently.
export const DEFAULT_PLACEMENT_OS: PlacementOs = "linux";

// The single point at which "which world does this run in?" is decided, and the ONLY thing that knows
// whether the answer was authored or defaulted.
//
// `placement.os` is optional, so every consumer defaulted it to linux on its own — and once provisioning
// was over, an authored `linux` and an unset os were the same byte. That makes "did this suite ever run on
// Windows?" and "was this case's world ever chosen deliberately?" unanswerable after the fact, which is
// exactly the question an OS-specific regression asks. So the resolution RETURNS its provenance, and the
// producers record it on the execution manifest instead of throwing it away.
export function resolvePlacementOs(placement?: { os?: PlacementOs }): {
  os: PlacementOs;
  resolved: "declared" | "defaulted";
} {
  const declared = placement?.os;
  return declared !== undefined
    ? { os: declared, resolved: "declared" }
    : { os: DEFAULT_PLACEMENT_OS, resolved: "defaulted" };
}

// A verifiable intermediate expectation on the way to the case's final outcome — case DATA, like `expected`.
// At judge time milestones merge into the judge's criteria (metric judge:<judge-id>:milestone:<id>), so when the
// final answer fails the verdict localizes WHICH intermediate step broke by checking each against the trace.
export const MilestoneSchema = z.object({
  id: z.string(), // metric suffix — judge:<judge-id>:milestone:<id>
  description: z.string(), // the expectation to verify against the trace (e.g. "logged in as the test user")
});
export type Milestone = z.infer<typeof MilestoneSchema>;

// A per-case seed for a purpose:"data" dependency store — the world-state the TASK operates on, so it is dataset-owned
// (the experiment INPUT), NOT harness config. Applied into the case's per-case isolation slice AFTER the warm topology
// is up and BEFORE the front-door drive, so concurrent cases don't collide. docs/architecture/dependency-store-roles.md P2.
// store enum is inlined (mirrors the topology store kinds) to keep this leaf module free of a harness-spec import cycle.
export const StoreFixtureSchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string().optional(), // bind to a specific dependency when several share a store kind (unset = the sole one of that kind)
  seed: z.union([
    z.object({ inline: z.string() }), // inline seed body (SQL / redis commands) — small fixtures
    z.object({ ref: z.string() }), // ArtifactStore ref (SQL dump / RDB / bucket tarball) — large fixtures
  ]),
  format: z.enum(["sql", "redis-cmds", "objects"]).optional(), // default inferred from the store kind at seed time
});
export type StoreFixture = z.infer<typeof StoreFixtureSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  // Reference output/answer — case DATA (rows of inputs/outputs), not grader config. answer-match falls back to it
  // and judges receive it as EXPECTED OUTPUT evidence. docs/architecture/eval-domain-model.md S5
  expected: z.string().optional(),
  // Intermediate expectations (ordered) — judges verify each against the trace to localize where a failed run broke.
  milestones: z.array(MilestoneSchema).optional(),
  // The case's OPTIONAL default grading plan (defaults to []). Grading is typically chosen at RUN time, not per case:
  // a scorecard run's `graders` replaces every case's plan (`applyGradingPlan`) and its `judges` score the trace — so a
  // dataset case is usually pure {id, env, task, expected} data with no per-case graders. Re-scoring never edits the dataset.
  graders: z.array(GraderSpecSchema).default([]),
  image: z.string().optional(),
  // World-state seeds for the harness's purpose:"data" dependency stores (P2). Absent = today (no seed). Each fixture
  // is applied into this case's isolation slice before the drive; a store-state grader can then verify the post-run slice.
  fixtures: z.array(StoreFixtureSchema).optional(),
  // Per-case execution budget (seconds). int+positive so it can be forwarded verbatim as the run-context timeout
  // (the dispatched agent plumbs it → EVERDICT_TIMEOUT_SEC-parity default). Dataset adapters set it from the task's
  // own max-agent-timeout; a long agent case (many LLM calls) is honored instead of clipped to a short default.
  timeoutSec: z.number().int().positive().default(1800),
  tags: z.array(z.string()).default([]),
  placement: PlacementSchema.optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// Execution provenance — stamped by the control plane (not self-reported by the runner). So the workspace can identify/trust-weight
// results run on an "unmanaged host" like a self-hosted runner. Unset by default (managed backends).
export const CaseProvenanceSchema = z.object({
  ranOn: z.string(), // e.g. "self-hosted"
  runner: z.string().optional(), // runner id (device)
  by: z.string().optional(), // the subject that ran it (principal.subject)
  // Workspace-billed models used on this run — stamped by the control plane at dispatch when a harness model's API
  // key resolved from the WORKSPACE secret tier (the team pays for those tokens, not the user's own login). Lets the
  // meter attribute per-model cost even on an own-pays personal self-hosted run: trace llm_calls whose `model`
  // matches one of these are billed to the workspace, the rest stay own-pays. `id` = registered model id,
  // `model` = its underlying model string (matches TraceEvent.llm_call.model). Absent = nothing workspace-billed.
  billedModels: z.array(z.object({ id: z.string(), model: z.string() })).optional(),
});
export type CaseProvenance = z.infer<typeof CaseProvenanceSchema>;

// The WORLD a case actually ran in — observed at the execution site by the producer that provisioned the
// compute, the sibling of `provenance` above (which is stamped by the CONTROL PLANE and says who ran it).
// Deliberately split that way: provenance is a claim the platform makes about a run, the manifest is a
// report the execution site makes about itself, and mixing the two would make neither auditable.
//
// A scorecard's manifest pins the evaluation DEFINITION (dataset/harness/judge versions, the verdict
// policy). Nothing pinned the evaluation WORLD, so a result carried no record of the os it landed on, the
// driver that provisioned it, or the image it came out of — the run was reproducible on paper and
// unreproducible in fact.
//
// Written ONLY where compute was genuinely provisioned or a topology genuinely deployed. A synthesized
// failure (dispatch died, retries ran out, an ingested trace) ran in no world at all, and inventing one for
// it would be the same fabrication the field exists to prevent — those results carry no manifest, and its
// ABSENCE reads as "not recorded", never as "linux".
export const ExecutionManifestSchema = z.object({
  // The RESOLVED world (resolvePlacementOs) — never absent while the manifest exists, because the manifest
  // is only written where the resolution actually happened.
  os: PlacementOsSchema,
  // Whether the case AUTHORED that os or the default decided it. The whole point of the manifest: without
  // this, `placement.os: "linux"` and no placement at all leave identical evidence.
  osResolved: z.enum(["declared", "defaulted"]),
  driver: z.string().optional(), // Driver.id — "local" | "docker" (absent on lanes that provision no Driver)
  image: z.string().optional(), // the image the compute was provisioned from (EvalCase.image)
  runtime: z.string().optional(), // TopologyRuntime.id — the topology lane's answer to "driver"
});
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

// The platform coordinates of a case whose collection is deferred out of the job (to the control plane) — when spec.trace.collect="control-plane"
// the agent loads it and executeCase completes the result by pull + scoring the deferred observation (kept as provenance even after collection).
// docs/architecture/streaming-case-pipeline.md D4
export const TraceRefSchema = z.object({
  kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]), // same as buildTraceSource's 5 kinds
  endpoint: z.string(),
  runId: z.string(), // correlation key (everdict.run_id) — used to find the trace on the platform
  // The authentication secret 'name' (SecretStore) — the control plane reinterprets it to the value at collect time and places it in the adapter-convention header
  // (otel/mlflow=verbatim Authorization, langsmith=x-api-key etc.). The value is never loaded (CaseResult is persisted).
  authSecret: z.string().optional(),
  correlate: z.enum(["id", "tag"]).optional(), // mlflow/otel — with tag, correlate by searching the everdict.run_id tag (resource attribute)
  experiment: z.string().optional(), // search scope for mlflow tag correlation (experiment id)
  project: z.string().optional(), // phoenix only — the project on the span lookup path
  service: z.string().optional(), // search scope for otel tag correlation (Jaeger service — the agent's service.name)
  mapping: SpanAttrMappingSchema.optional(), // per-harness span→TraceEvent attribute overrides (carried to control-plane collect)
});
export type TraceRef = z.infer<typeof TraceRefSchema>;

// An in-run environment delta captured DURING execution (not just the final snapshot) — today: a non-intrusive repo
// git-diff vs HEAD sampled over time, so a coding harness's replay shows how the repo evolved. Inline text (small,
// capped, deduped); the control plane folds these into the sealed recording at finalize. A future slice offloads a
// large diff to a stateDeltas ref. Rides the CaseResult, so it works self-hosted AND managed. docs/architecture/replay.md.
export const EnvDeltaSchema = z.object({
  t: z.number(), // wall-clock ms — shares the recording/trace t0 clock
  kind: z.enum(["repo-diff"]),
  text: z.string(),
});
export type EnvDelta = z.infer<typeof EnvDeltaSchema>;

// Which EVIDENCE ERA produced a result — what a reader may conclude from a field being absent.
// 1 = the pre-seal era (no producer could vouch for trace completeness). 2 = every producer stamps this and
// seals when it CAN vouch, so an absent seal is a real statement about that result rather than an artefact of
// its age. Absent on rows written before the field existed = era 1 by definition.
// A new era is a NEW NUMBER, never a redefinition of an old one: the point is that a record keeps meaning what
// it meant when it was written.
export const CURRENT_EVIDENCE_VERSION = 2;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  harness: z.string(), // "claude-code@1.2.3"
  // The evidence era this result was produced in (CURRENT_EVIDENCE_VERSION). Without it, "written before the
  // seal existed" and "written by a producer that declined to vouch" are the same absence, and evidenceStatus
  // had to give both the STRONGEST reading — so a result with no seal read as complete evidence forever.
  evidenceVersion: z.number().int().optional(),
  // Trial index (0-based) when the same case is run N times for pass@k / flakiness. Absent (or 0) = a single-run
  // case — a Scorecard may hold multiple results with the same caseId, distinguished by trial. Aggregation groups
  // by caseId; the per-trial verdict reuses caseVerdict. docs/architecture/trial-based-verdict.md
  trial: z.number().int().nonnegative().optional(),
  trace: z.array(TraceEventSchema),
  // POSITIVE trace seal — the producer VOUCHES that collection ran to completion (runCase's normal path).
  // "has events + no recorded collect failure" is only absence of bad news; a trace truncated without a
  // recorded failure is indistinguishable from a complete one unless the producer says so. Absent on legacy
  // rows and on producers that cannot vouch — and `evidenceVersion` above is what tells those two apart.
  traceSealed: z.boolean().optional(),
  // The absolute instant this result's trace `t` offsets count from, DECLARED by the producer that knows it
  // (the topology backend: the front-door drive's start). The sealer passes it through as the execution
  // segment's `t0`, which is what lets a trace whose events carry only relative `t` (an inline front-door
  // trace) land on the same wall-clock axis as the placement plane. Only a producer that can vouch for the
  // offset semantics sets it — events that carry their own `at` are never affected (`at` wins per event).
  traceT0: z.string().optional(),
  snapshot: EnvSnapshotSchema,
  scores: z.array(ScoreSchema),
  // Classified failure (WHERE it died × WHOSE fault) — set when the case did not produce a normal eval outcome
  // (dispatch/install/run/collect/grade error). Absent on a clean run, including a legitimate agent FAIL
  // (that is a grader verdict, not a failure). Drives class-aware retry. docs/architecture/batch-resilience.md
  failure: CaseFailureSchema.optional(),
  provenance: CaseProvenanceSchema.optional(), // provenance of unmanaged execution like self-hosted (control-plane stamp)
  // The world this case ran in, self-reported by the execution site (above). Absent = the producer
  // provisioned nothing and has nothing to report — NOT "it ran on linux". Purely additive, so it does not
  // move the evidence era: an era-2 row with no manifest is a row nobody recorded a world for.
  execution: ExecutionManifestSchema.optional(),
  traceRef: TraceRefSchema.optional(), // control-plane collection target (above) — absent for job collection (default)
  // Evidence extracted from a pulled trace (mapping evidence slots) — the carrier that brings CUSTOM named slots
  // to the judges (GradeContext.evidence); the fixed slots also synthesize the browser snapshot above.
  evidence: TraceEvidenceSchema.optional(),
  // Object-store pointer to the sealed replay recording (frames/env/runtime tracks on a shared t0 clock) — sibling of
  // traceRef, coordinates never bytes. Absent unless recording was requested. docs/architecture/replay.md
  recordingRef: RecordingRefSchema.optional(),
  // In-run environment deltas (repo git-diff checkpoints over time) — the environment plane for a non-visual harness.
  // Folded into the recording at seal, then cleared (not double-stored on the persisted result). docs/architecture/replay.md.
  envDeltas: z.array(EnvDeltaSchema).optional(),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
