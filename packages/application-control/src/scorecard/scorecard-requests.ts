import {
  type CaseMatcher,
  type Dataset,
  EnvSnapshotSchema,
  type GraderSpec,
  type JudgeRunConfig,
  ScoreSchema,
  type ScorecardOrigin,
  TraceEventSchema,
  TraceEvidenceSchema,
} from "@everdict/contracts";
import { z } from "zod";

// The scorecard use-cases' REQUEST shapes (review §22): body DTOs both transports validate against, the
// submit input contracts, and the submission-path provenance mapping. Wire concerns — none of this belongs
// beside the deps bag or the observability seam it used to share a file with.

// Trace-ingest body — upload traces already produced externally without running the harness (edge-normalized: TraceEvent[] upload).
// dataset/harness are OPTIONAL labels/refs: with a dataset each trace aligns to a case (expected/graders + diff alignment);
// WITHOUT one, every uploaded trace becomes its own case and judges score it directly (the "evaluate traces" path — the
// scorecard is stamped with the TRACE_EVAL_REF sentinel dataset/harness). Validated at the boundary with TraceEventSchema.
export const IngestScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
  traces: z
    .array(
      z.object({
        caseId: z.string(),
        trace: z.array(TraceEventSchema),
        snapshot: EnvSnapshotSchema.optional(),
        evidence: TraceEvidenceSchema.optional(), // pulled-trace evidence (mapping slots) — carries custom judge slots
        scores: z.array(ScoreSchema).optional(),
      }),
    )
    .min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type IngestScorecardBody = z.infer<typeof IngestScorecardBodySchema>;
export type IngestScorecardInput = IngestScorecardBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  // Owning team — decided by the transport (teamForNew), exactly as it is for a live run. An ingested batch is a
  // result like any other; born unowned it would sit in every team's list forever.
  teamId?: string;
  origin?: ScorecardOrigin;
};

// pull-ingest body — pull per-runId traces from the tenant's OTel/MLflow and score them (harness not run).
// dataset/harness are OPTIONAL labels (see IngestScorecardBodySchema): omit both to evaluate the pulled traces directly
// (each trace = one case, judges only, TRACE_EVAL_REF sentinel) — the "pick traces from a trace source + judge" path.
// The source is EITHER a registered workspace trace source referenced by name ("register once, pull by name" — the
// low-friction path) OR an inline ad-hoc config. Named: credential/kind/endpoint come from the pool; inline: credentials
// come only via the authSecret name (SecretStore) — no plaintext token in the spec.
export const PullIngestBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
  source: z.union([
    // a registered workspace source (Settings › Observability) — the whole connection is already stored under this name.
    // `correlate` overrides the source's stored setting for THIS pull: the "evaluate existing traces" flow already holds
    // the platform's real trace ids (from listTraces), so it forces "id" (fetch-by-trace-id) even if the source is
    // normally used with "tag" (find-by-everdict-run_id) correlation. Absent = the source's own setting.
    z.object({ name: z.string().min(1), correlate: z.enum(["id", "tag"]).optional() }),
    z.object({
      kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
      endpoint: z.string().url(),
      // SecretStore key name → its value used as the credential. otel/mlflow use the Authorization header verbatim (scheme included:
      // "Bearer …"|"Basic …"); for langfuse/langsmith/phoenix the adapter places it in the platform's conventional header (langsmith=x-api-key).
      authSecret: z.string().optional(),
      project: z.string().optional(), // required for phoenix span-lookup path (project name/ID) · mlflow experiment for tag search.
      // Correlation for the inline config — the same axes the registered pool carries. Pre-fix these were silently
      // STRIPPED (no .strict()), so an inline mlflow/otel pull could only ever fetch by trace id: a client passing
      // correlate:"tag" got id-fetch and a batch of empty traces with no hint why.
      correlate: z.enum(["id", "tag"]).optional(), // default id (fetch runId AS the trace id)
      correlateTag: z.string().optional(), // the tag key searched when correlate:"tag" (default everdict.run_id)
      service: z.string().optional(), // otel/jaeger tag-search scope (required by the Jaeger query API)
      artifactBaseUrl: z.string().optional(), // resolve root-relative evidence artifact refs during the pull
    }),
  ]),
  runs: z.array(z.object({ caseId: z.string(), runId: z.string() })).min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type PullIngestBody = z.infer<typeof PullIngestBodySchema>;
export type PullIngestInput = PullIngestBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  teamId?: string; // owning team — decided by the transport, same as the push-ingest above
  origin?: ScorecardOrigin;
};

// principal.via → origin.source mapping — submission-path provenance (where it was fired from).
// oidc=human (web UI token), github-actions=CI OIDC federation, else (api-key/runner)=api. Scheduled fires stamp "schedule" directly.
export function originSource(via: string): string {
  if (via === "oidc") return "web";
  if (via === "github-actions") return "github-actions";
  return "api";
}

export interface RunScorecardInput {
  // Who this batch belongs to, in precedence order. The eval assets carry the same axis, which is what makes
  // "what has our team evaluated" answerable without walking every harness.
  //   · teamId          — the owner the CALLER named. The transport authorized it, so it wins outright.
  //   · (the harness's own team, resolved here) — what a batch inherits when nobody said: evaluating a team's
  //     harness produces that team's result, and it is the only answer the headless callers have.
  //   · submitterTeamId — the transport's fallback (the caller's team, else the workspace default), used only
  //     when the harness is unowned too. Separate from `teamId` because it is NOT a claim the caller made, and
  //     collapsing the two would let an arbitrary "first membership" outrank what actually ran.
  teamId?: string;
  submitterTeamId?: string;
  tenant: string;
  // INTERNAL (experiment façade only — routes never expose these two): group kind stamped on the record, and a
  // pre-resolved dataset that BYPASSES the registry lookup (the ad-hoc task path / the graders-stripped copy).
  // docs/architecture/execution-model.md P1.
  kind?: "experiment";
  inlineDataset?: Dataset;
  // submitter (principal.subject) — the owner used to resolve a private-repo case's personally-owned connection ("clone via my connection").
  // Consequently a private-repo dataset is effectively single-owner (a case's connectionId only resolves when that owner submits).
  submittedBy?: string;
  // The submitter's roles (principal.roles) — the constitution seed reads them: a run-time grader declaring
  // ground_truth authority redefines what passing MEANS, and that is an admin's call, not any member's.
  submitterRoles?: string[];
  dataset: { id: string; version: string };
  // pins = submit-time ephemeral pin overrides (slot→image, registry unchanged) — a CI PR fire swaps one service image for evaluation.
  // Recorded in origin.pinOverrides (reproducibility evidence). Durable changes go through POST /harnesses/:id/pins (a new instance version).
  harness: { id: string; version: string; pins?: Record<string, string> };
  origin?: ScorecardOrigin; // trigger origin (provenance) — the route/schedule stamps source
  judges?: Array<{ id: string; version: string }>; // selected Agent Judges — applied to the trace
  // Run-time grading plan — replaces every case's default graders for THIS batch (the dataset stays pure data).
  // Persisted in orchestration so resume/retry re-apply it. Absent = each case's own graders.
  graders?: GraderSpec[];
  // Cases whose failure is a product judgment, not a statistical question: a release gate blocks on a
  // critical case's collapse regardless of significance and regardless of its regression budget. Composed
  // INTO this batch's verdict policy (composeVerdictPolicy) so the declaration is digested, carried in the
  // manifest, and resolved with the rest of the stamp — a gate decision must be re-derivable from the record.
  criticalCases?: CaseMatcher[];
  runtime?: string; // tenant Runtime id to run on (placement.target). Absent = default backend.
  judge?: JudgeRunConfig; // inline judge-grader scoring-model override (defaults to the workspace default if unset)
  // Number of cases to dispatch concurrently within one batch (runSuite parallelism). Defaults to the service default if unset.
  // On self-hosted runtimes this many jobs park in the lease queue, and the runner must lease that many concurrently for real case-level parallelism.
  concurrency?: number;
  // Partial run — run only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit selection) → tags (any-match) → limit (first N).
  // The result record is stamped with subset{total,selected,…} to mark that it is "not the whole thing".
  cases?: { ids?: string[]; tags?: string[]; limit?: number };
  // Transient dispatch retries per case (a THROWING dispatch only — a failing eval result is never retried).
  // Default 1. docs/architecture/batch-resilience.md
  retries?: number;
  // Run each case this many times for pass@k / flakiness (>=1). Absent = 1 (single run). Each case fans out into N
  // dispatches; the detail carries a derived trialSummary (pass@k / flake rate). docs/architecture/trial-based-verdict.md
  trials?: number;
  // Per-batch trace-sink override — the name of a configured workspace sink, or "none" to suppress export for
  // this batch. Absent = the harness's own selection (traceSinkByHarness). docs/architecture/trace-sink.md
  traceSink?: string;
  // In-batch OOM auto-boost (opt-in — every boost re-runs the case): an OOM_KILLED case re-dispatches inside
  // the batch with doubled job-only memory up to the cap, instead of waiting for a retry-failed round-trip.
  oomAutoBoost?: boolean;
}

// P1 experiment submit — phase 1 alone (execution-model.md): EXACTLY ONE of `dataset` (registered cases,
// graders stripped for this group) or `task` (one ad-hoc prompt case under the EXPERIMENT_ADHOC_REF sentinel).
export interface SubmitExperimentInput {
  tenant: string;
  submittedBy?: string;
  harness: { id: string; version: string };
  dataset?: { id: string; version: string };
  task?: { prompt: string; timeoutSec?: number };
  trials?: number; // drive the task/cases N times (pass@k-style repetition without the verdict)
  runtime?: string;
  concurrency?: number;
  retries?: number;
  cases?: { ids?: string[]; tags?: string[]; limit?: number }; // subset selection (dataset experiments only)
  origin?: ScorecardOrigin;
}
