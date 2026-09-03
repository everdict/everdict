import { z } from "zod";
import { NetworkPolicySchema, ResourceRequestSchema } from "../infra/world.js";
import { CaseFailureSchema } from "./case-failure.js";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema, sanitizeScore } from "./grader.js";
import { ImageProvenanceSchema } from "./image-provenance.js";
import { ProvisionedWorldProofSchema } from "./provisioned-world.js";
import { RecordingRefSchema } from "./recording.js";
import { SessionAcquireSchema } from "./session-acquire.js";
import { SpanAttrMappingSchema, TraceEvidenceSchema } from "./trace-source.js";
import { TraceEventSchema, stripPlatformAuthoredFields } from "./trace.js";
import { MetricAuthoritySchema, builtInOwnedMetrics, isConstitutionalMetric } from "./verdict-policy.js";
import { VerifierReceiptSchema } from "./verifier-receipt-record.js";

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
  // WHAT THIS GRADER MEASURES, named separately from what it IS (arch-review 19 P1).
  //
  // `id` does two jobs: it selects the implementation (`script`, `command`, `judge`…) AND, through
  // `authority` above, it names the metric those semantics apply to. Those are the same string only for the
  // graders whose metric happens to equal their type. A script grader is declared as `id: "script"` with
  // `config.id: "business-check"` and prints `metric: "quality"` — so an `authority` declaration composed a
  // policy entry for the metric `"script"`, which nothing ever emits, while the score that actually landed
  // carried no declared semantics at all. The declaration and the measurement were about different names.
  //
  // `metrics` says it directly: these metric ids, with these semantics. When present it REPLACES the id-based
  // reading — a spec that names its metrics is not also claiming its type is one. It is additive so every
  // existing dataset keeps its meaning, and it is what a custom-grader ecosystem needs before it grows.
  metrics: z
    .array(
      z.object({
        id: z.string().min(1),
        authority: MetricAuthoritySchema.optional(),
        direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).optional(),
      }),
    )
    .optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

// The half of a grader's entitlement a DECLARATION can grant: the metric ids the spec names, minus the
// constitutional ones (arch-review 20 P0-1 — declaring `state` is not acquiring it). ONE spelling, read by
// `makeGraders` when it stamps the runtime grader and by `sanitizeSubmittedResult` when the control plane asks
// again at settle. Written twice it had already diverged: the settle's first draft granted every declared id,
// which is the wildcard the producer boundary had closed a review earlier.
export function declaredOwnedMetrics(spec: Pick<GraderSpec, "metrics">): readonly string[] {
  return (spec.metrics ?? []).map((m) => m.id).filter((id) => !isConstitutionalMetric(id));
}

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
  // ── THE WORLD THIS CASE NEEDS, AS DATA THE CASE OWNS ───────────────────────────────────────────────
  //
  // `placement` says WHERE the work goes; these say WHAT KIND OF WORLD it must be once it gets there, and
  // they belong to the case rather than the harness because they are properties of the TASK: a build task
  // needs 4 GB whichever agent attempts it, and an offline reasoning task must be offline for every
  // harness being compared. The container-task benchmark corpora state both routinely — tens of thousands
  // of tasks declare a cpu/memory envelope and thousands declare an internet policy.
  //
  // Both are OPTIONAL and absent means what it always meant: the runtime's default box, ordinary network.
  // What they must never become is advisory — an execution site that cannot provide the declared world
  // REFUSES the case (`ComputeSpec` below), because the failure mode of ignoring them is silent and
  // scoring-relevant: an under-provisioned case reads as an agent that failed, and an offline benchmark
  // that ran online measured something the benchmark does not claim to measure.
  resources: ResourceRequestSchema.optional(),
  network: NetworkPolicySchema.optional(),
  // ── WHERE THE PROVIDED WORLD IS, WRITTEN BY THE PLATFORM (world-and-engagement-model.md) ──────────
  //
  // A world the actor reaches by coordinates rather than by being inside it. PLATFORM-AUTHORED: the control
  // plane resolves the case's environment reference and attaches what that version says, so the value is the
  // sealed world's, never a case author's guess — a dataset that hard-coded a URL would have no identity to
  // seal and no axis to move. Absent = the world is the actor's own container (or there is none).
  world: z
    .object({
      wiring: z.record(z.string().min(1), z.string().min(1)).default({}),
      // A world still to be OPENED for this case, carried as the platform's own intent between the moment the
      // environment is resolved and the moment the dispatch opens it. It never crosses the process boundary:
      // the providing dispatcher acquires the session, merges the coordinates into `wiring`, and REMOVES this
      // before the job is dispatched — a runner receives coordinates, never the credentials-shaped means of
      // minting more of them.
      session: z.object({ endpoint: z.string().url(), acquire: SessionAcquireSchema }).optional(),
    })
    .optional(),
  // ── HOW THE ACTOR MEETS THE QUESTION (world-and-engagement-model.md, axis 2) ──────────────────────
  //
  // Every case in this repository has been ONE-SHOT: the actor is handed the task and produces a trace. A
  // whole class of benchmarks is not — the case IS a conversation, and what is measured is where the agent
  // ends up after several exchanges with a user.
  //
  // Engagement belongs to the CASE rather than to the harness because it is a property of the QUESTION
  // ("this task is a dialogue"); the harness merely has to be capable of it, which it declares as
  // `conversational`. A dialogue case meeting a one-shot harness is refused by name — each "turn" would be
  // an independent run, so the conversation would be a fiction and the number would measure nothing.
  //
  // `scripted` is the user this ships with: the case carries the user's turns, so the exchange is fixed data
  // like every other part of the question and two runs of the case ask the same thing. A model-driven
  // simulator is a different user KIND (a later slice) and it plugs in here, not into the loop.
  engagement: z
    .object({
      kind: z.literal("dialogue"),
      user: z.object({ kind: z.literal("scripted"), turns: z.array(z.string().min(1)).min(1) }),
      // The bound on the whole exchange, counting the opening task as turn 1. Absent = as many turns as the
      // user has lines; a smaller value truncates them, which is what makes a shared dataset runnable under
      // a tighter budget without editing the cases.
      maxTurns: z.number().int().positive().max(50).optional(),
    })
    .optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// Execution provenance — stamped by the control plane (not self-reported by the runner). So the workspace can identify/trust-weight
// results run on an "unmanaged host" like a self-hosted runner. Unset by default (managed backends).
export const CaseProvenanceSchema = z.object({
  ranOn: z.string(), // e.g. "self-hosted"
  runner: z.string().optional(), // runner id (device)
  by: z.string().optional(), // the subject that ran it (principal.subject)
  // The TRUST CLASS of this run's execution claims (review §16): "self_reported" = the ExecutionManifest and
  // the result came from compute the control plane does not operate (a self-hosted runner) — honest, but a
  // self-report; "managed" = the platform itself provisioned and observed the execution. A managed run
  // usually carries NO provenance at all (absence = the platform's own dispatch), so this field mostly
  // stamps the self-reported side. Consumers must not merge the two into one strong claim — "verified on
  // Windows 2025" is a statement only a managed/verified execution supports.
  attestation: z.enum(["managed", "self_reported"]).optional(),
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
  // ERA 1 ONLY. A verbatim copy of the REQUEST (`EvalCase.image`) — a reference nothing ever resolved, so
  // `repo:latest` here names whichever bytes the daemon happened to hold. Never written by an era-2
  // producer and never read except through `imageProvenanceOf`, which reports it as unresolved.
  image: z.string().optional(),
  runtime: z.string().optional(), // TopologyRuntime.id — the topology lane's answer to "driver"
  // The DECLARED manifest era (the MANIFEST_IDENTITY_VERSION pattern). Absent = era 1: `image` is a request
  // nobody resolved, AND its absence is ambiguous — a lane that provisioned an image and left the field
  // blank (every k8s/nomad batch, every topology case) is indistinguishable from one that provisioned none.
  // That ambiguity is exactly why an era-1 manifest reads as `unresolved{legacy_era}` and never as `none`.
  // Detecting the era from the MARKER rather than from field absence is what makes "an era-2 producer that
  // forgot to state its provenance" a detectable bug instead of a silent slide back to era 1.
  manifestVersion: z.number().int().positive().optional(),
  // Which image bytes this case actually ran from. Required at era 2 — the reader enforces it, because the
  // stored blob must keep parsing rows written before the field existed.
  imageProvenance: ImageProvenanceSchema.optional(),
  // ── AND THE REST OF THE WORLD, NOT JUST ITS IMAGE (arch-review 59 P1-high) ──────────────────────────
  //
  // The `execution_world` axis compared image BYTES and nothing else, so two sides of a comparison could hold
  // that axis while one ran with a GPU and the other without, or one behind a deny-all egress policy and the
  // other online. Those are different worlds by every definition this repo uses — `worldProofCovers` refuses
  // an inexact match on exactly these fields at admission — and a regression measured across them is not
  // evidence about the change under test, which is the whole thing the axis exists to say.
  //
  // The proof already existed and simply had no reader downstream: the lane attests what it ENFORCED, the
  // in-container driver refuses a declaration the proof does not cover, and then nobody wrote it down. This
  // is the attested value, recorded by the site that consumed it — not the case's declaration, which is what
  // was ASKED for and is exactly the copy rule `protocol` forbids stamping as proof.
  //
  // Absent means what it means everywhere else on this axis: this placement constrained nothing it can name.
  // Two such sides are not "the same world", they are two worlds nobody stated — which the axis reports as
  // unverified rather than held.
  world: ProvisionedWorldProofSchema.optional(),
});
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

// The era an execution manifest was written in. Bump whenever a new facet joins the manifest; a producer
// stamps the current constant, and a reader may conclude nothing about facets a lower era never recorded.
export const CURRENT_EXECUTION_MANIFEST_ERA = 2;

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
  // ── WHAT THIS CASE STAGED USED TO LIVE HERE, AND IT WAS THE WRONG DOCUMENT (arch-review 66) ───────
  //
  // arch-review 65 put the intermediates' cleanup coordinate on this schema so that every ending — not only
  // the one carrying a verifier receipt — could address what it staged. The problem it solved was real; the
  // place was not. `CaseResult` is the MEASUREMENT, and putting platform lifecycle state on it cost three
  // things at once:
  //
  //   • the normal path attached the field and the recovery path did not, so one execution produced two
  //     different `caseResultDigest`/`caseObservationDigest` values depending on whether a process crashed;
  //   • `submit_job_result` parses a self-hosted runner's JSON with this schema, so a workspace-controlled
  //     runner could name the objects a settlement would delete;
  //   • it reads as evidence, because everything around it is.
  //
  // The debt now lives in `IntermediateCleanupStore` (@everdict/application-control), written by the pass
  // that stages the bytes and keyed by EXECUTION — a coordinate every ending can name without carrying
  // anything on the document. A result is what the agent did; what the platform still owes is not.
  // POSITIVE judgment seal, the same grammar as the trace one above: the scorer VOUCHES that every judge it
  // ran got its own execution sealed as evidence on this run's trajectory. Sealing is best-effort by
  // contract — a lost seal must not lose a real verdict — and the loss used to be silent, so a judgment
  // whose account is gone read exactly like one whose account is on file (arch-review 58 follow-through).
  // `false` = at least one judgment cannot be re-inspected. Absent = no judge ran, or a producer that
  // cannot vouch; `evidenceVersion` is what tells those from a demotion.
  judgmentsSealed: z.boolean().optional(),
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
  // ── WHAT PRODUCED THE VERIFIER'S HALF OF THIS VERDICT (arch-review 57 P1) ────────────────────────
  //
  // The deciding scores used to arrive alone, so the record could report `tests_pass` and not say which
  // procedure read which workspace in which runtime to reach it. Sealed by `verifierReceiptOf`
  // (@everdict/domain) at the invocation, which is where all of it is known. Absent on a case with no
  // private verifier — most of them — and on a lane that could not judge, which says so as `unmeasured`.
  verifier: VerifierReceiptSchema.optional(),
  // The platform trace this result was scored FROM (pull-ingest / a topology harness whose trace is pulled).
  // Carried so the judged result can point back at the evidence it judged — the export writes a link to it
  // rather than assuming its own external id addresses the same place.
  sourceTraceId: z.string().optional(),
  // Object-store pointer to the sealed replay recording (frames/env/runtime tracks on a shared t0 clock) — sibling of
  // traceRef, coordinates never bytes. Absent unless recording was requested. docs/architecture/replay.md
  recordingRef: RecordingRefSchema.optional(),
  // In-run environment deltas (repo git-diff checkpoints over time) — the environment plane for a non-visual harness.
  // Folded into the recording at seal, then cleared (not double-stored on the persisted result). docs/architecture/replay.md.
  envDeltas: z.array(EnvDeltaSchema).optional(),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

// What every door that receives a `CaseResult` FROM A PRODUCER parses with — a self-hosted runner's
// `submit_job_result`, and the `__EVERDICT_RESULT__` sentinel a dispatched job prints on stdout.
//
// The document carries two kinds of platform coordinate: the trace's `…Ref` fields, and the snapshot's
// `screenshotRef`/`domRef`. The snapshot pair is the sharper one — the read path re-signs them into a
// browser-facing presigned URL (`refreshSnapshotRefs` → `publicUrlFor`), and the artifact bucket is ONE
// bucket for the deployment, so a producer naming a key would receive a signed URL that leaves our
// authorization behind entirely rather than merely bypassing one check.
//
// Same rule as `UntrustedTraceEventSchema`, same reason: `artifact://` is our scheme, and a producer may not
// author one. See `stripPlatformAuthoredFields` for why a local path survives.
// ── AND THE PLATFORM'S OWN STATEMENTS ABOUT THE MEASUREMENT (arch-review 122) ────────────────────────
//
// `CaseResult` is what the AGENT did. Two of its fields are what the CONTROL PLANE says about that, and both
// were arriving on the producer's document:
//
//   provenance   "stamped by the control plane at dispatch" — and it decides WHO PAYS. A forged
//                `{ranOn: "self-hosted", by: <not ws:>}` makes `billingTenant` answer `undefined`, so the
//                case is never charged, never metered and consumes no budget; `by: "ws:<victim>"` charges a
//                workspace that did not run it and drains its enforcement budget.
//   verifier     "Sealed by `verifierReceiptOf` at the invocation" — the private verifier's receipt, which is
//                constitutional evidence and carries the attempt ids a settlement joins on. The verifier has
//                its OWN sentinel (`VERIFIER_RESULT_SENTINEL`); the agent half never authors one.
//
// The self-hosted lane already overwrote provenance (`{...result, provenance: {…}}`), so that door was safe
// by accident of ORDER. The managed lane never touches it — `placement-image` rewrites `execution` and
// nothing else — and a workspace supplies the job-runner image that prints the sentinel
// (`RuntimeSpec.image`, "job-runner image (tenant registry)"). One lane learned, its sibling did not.
//
// ⚠️ THE LAW IS ALREADY IN THIS FILE, twenty lines above `verifier`: the arch-review 66 comment explaining
// why the cleanup coordinate was REMOVED from this schema, whose second bullet is verbatim the mechanism
// here. Absence is also the CORRECT default — `billingTenant` bills the dispatching tenant when provenance
// is absent, and a managed run "usually carries NO provenance at all" by the field's own comment.
//
//   judgmentsSealed  set ONLY by `ScoringService` (@everdict/application-control — the control plane), and
//                    only `if (specs.length > 0)`. Its own comment says why: "a blanket `true` would turn
//                    silence into evidence". So the platform refuses to claim it for a case no judge ran —
//                    and then accepted a producer claiming it, which `evidenceStatusOf` reads as `complete`.
//                    The stamp exists precisely to be unclaimable by silence; a producer sending it is that
//                    silence, wearing the claim.
//
// `traceSealed` deliberately STAYS. Its comment says the distinction exists "unless the PRODUCER says so",
// and `evidenceVersion` beside it exists to tell a producer that cannot vouch from a legacy row — that is a
// vouch by design, not a stamp. This is a trust boundary, not a field sweep, and the counterexample asserts
// the surviving field so it cannot decay into one.
const PLATFORM_STAMPED_RESULT_FIELDS = ["provenance", "verifier", "judgmentsSealed"] as const;

// ── THE COLLECTION BOUNDARY THE CONTROL PLANE NEVER HAD ─────────────────────────────────────────────
//
// `safeGrade` sanitizes a grader's scores against what that grader's spec DECLARED, inside the job — on the
// self-hosted lane, the producer's own machine. Nothing re-asked at the control plane: the untrusted schema
// strips the fields the PLATFORM stamps and never looks at score authority, and `evaluateVerdict` ranks by
// metric NAME against the stamped policy, whose default ladder gives `state`/`tests_pass` ground truth. A
// producer could name its way past every judge on the case, into the trials, the round and the adoption.
//
// What a producer is entitled to comes from the two sources the runtime class would have carried, and this
// seam holds only the declaration: the built-in's own name (`BUILTIN_GRADER_OWNED_METRICS` — `{ id:
// "tests-pass" }` says nothing about `tests_pass` on its own) and the names a declaration may grant
// (`declaredOwnedMetrics`, never a constitutional one). A score whose graderId matches no declared grader owns
// nothing — the honest answer, not a special case; `Run.newSessionCase` already writes `graders: []` to say
// exactly that, and it is what makes a runner's `tests-pass` on a case that never asked for one a forgery.
//
// ⚠️ SCOPE, STATED. The judge family is left as it is (`ownsJudgeVerdict: true`): its entitlement lives on the
// runtime `Grader` class, which a `GraderSpec` does not mirror, and inline judge scores come back through this
// same door. Inventing a correspondence would invalidate legitimate judge rows in the one place where
// "invalid" decides what passing means. Adding `ownsJudgeVerdict` to the spec is its own change.
export function sanitizeSubmittedResult(result: CaseResult, graders: readonly GraderSpec[]): CaseResult {
  if (result.scores.length === 0) return result;
  return {
    ...result,
    scores: result.scores.map((score) => {
      const spec = graders.find((g) => g.id === score.graderId);
      return sanitizeScore(score, {
        kind: "grader",
        id: score.graderId,
        ownsMetrics: spec === undefined ? [] : [...builtInOwnedMetrics(spec.id), ...declaredOwnedMetrics(spec)],
        ownsJudgeVerdict: true,
      });
    }),
  };
}

export const UntrustedCaseResultSchema = z.preprocess((value) => {
  const stripped = stripPlatformAuthoredFields(value);
  if (stripped === null || typeof stripped !== "object" || Array.isArray(stripped)) return stripped;
  const copy: Record<string, unknown> = { ...(stripped as Record<string, unknown>) };
  for (const field of PLATFORM_STAMPED_RESULT_FIELDS) delete copy[field];
  return copy;
}, CaseResultSchema);

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

// The user's turns this case will actually take, in order, after the opening task — the ONE reader of the
// engagement's bound, so the loop and anything that previews a dialogue count the same exchange. Empty for a
// one-shot case, which is every case that declares no engagement.
export function dialogueTurns(evalCase: Pick<EvalCase, "engagement">): string[] {
  const engagement = evalCase.engagement;
  if (engagement === undefined) return [];
  // The opening task is turn 1, so `maxTurns` leaves `maxTurns - 1` for the user.
  const budget = engagement.maxTurns === undefined ? engagement.user.turns.length : engagement.maxTurns - 1;
  return engagement.user.turns.slice(0, Math.max(0, budget));
}
