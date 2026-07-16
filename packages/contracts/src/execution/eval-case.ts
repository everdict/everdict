import { z } from "zod";
import { CaseFailureSchema } from "./case-failure.js";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { SpanAttrMappingSchema } from "./trace-source.js";
import { TraceEventSchema } from "./trace.js";

// Grader spec: id + optional config (e.g. tests-pass's { cmd }).
// The agent reconstructs a Grader instance from this spec.
export const GraderSpecSchema = z.object({
  id: z.string(),
  config: z.record(z.unknown()).optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

// Placement hint — the control-plane router reads it when deciding which backend to send to.
// The agent ignores this field (where it runs is not the agent's concern).
export const PlacementSchema = z.object({
  target: z.string().optional(), // registered backend name (e.g. "nomad-seoul")
  os: z.enum(["linux", "windows", "macos"]).optional(),
  isolation: z.string().optional(), // e.g. "gvisor"
});
export type Placement = z.infer<typeof PlacementSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  // Reference output/answer — case DATA (rows of inputs/outputs), not grader config. answer-match falls back to it
  // and judges receive it as EXPECTED OUTPUT evidence. docs/architecture/eval-domain-model.md S5
  expected: z.string().optional(),
  // The case's OPTIONAL default grading plan (defaults to []). Grading is typically chosen at RUN time, not per case:
  // a scorecard run's `graders` replaces every case's plan (`applyGradingPlan`) and its `judges` score the trace — so a
  // dataset case is usually pure {id, env, task, expected} data with no per-case graders. Re-scoring never edits the dataset.
  graders: z.array(GraderSpecSchema).default([]),
  image: z.string().optional(),
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
});
export type CaseProvenance = z.infer<typeof CaseProvenanceSchema>;

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

export const CaseResultSchema = z.object({
  caseId: z.string(),
  harness: z.string(), // "claude-code@1.2.3"
  // Trial index (0-based) when the same case is run N times for pass@k / flakiness. Absent (or 0) = a single-run
  // case — a Scorecard may hold multiple results with the same caseId, distinguished by trial. Aggregation groups
  // by caseId; the per-trial verdict reuses caseVerdict. docs/architecture/trial-based-verdict.md
  trial: z.number().int().nonnegative().optional(),
  trace: z.array(TraceEventSchema),
  snapshot: EnvSnapshotSchema,
  scores: z.array(ScoreSchema),
  // Classified failure (WHERE it died × WHOSE fault) — set when the case did not produce a normal eval outcome
  // (dispatch/install/run/collect/grade error). Absent on a clean run, including a legitimate agent FAIL
  // (that is a grader verdict, not a failure). Drives class-aware retry. docs/architecture/batch-resilience.md
  failure: CaseFailureSchema.optional(),
  provenance: CaseProvenanceSchema.optional(), // provenance of unmanaged execution like self-hosted (control-plane stamp)
  traceRef: TraceRefSchema.optional(), // control-plane collection target (above) — absent for job collection (default)
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
