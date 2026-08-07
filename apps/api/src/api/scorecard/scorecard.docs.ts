import { IngestScorecardBodySchema, PullIngestBodySchema } from "@everdict/application-control";
import { GateDecisionSchema, ManifestVerificationSchema } from "@everdict/contracts";
import { BackfillModelsResponseSchema } from "@everdict/contracts/wire";
import { ScorecardAnalysisBundleResponseSchema, ScorecardAnalysisResponseSchema } from "@everdict/contracts/wire";
import { DeleteScorecardResultSchema } from "@everdict/contracts/wire";
import { LeaderboardResponseSchema } from "@everdict/contracts/wire";
import { RescoreUnmeasuredResultSchema } from "@everdict/contracts/wire";
import { ScorecardDiffResponseSchema } from "@everdict/contracts/wire";
import { ScorecardEstimateResponseSchema } from "@everdict/contracts/wire";
import { ScorecardListResponseSchema } from "@everdict/contracts/wire";
import { ScorecardTrendResponseSchema } from "@everdict/contracts/wire";
import { ScorecardResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { teamMoveDocs } from "../team-move.js";
import { AnalysisQueryBodySchema } from "./request/analysis-query.js";
import { GateScorecardsBodySchema, OverrideGateBodySchema } from "./request/gate-scorecards.js";
import { RerunScorecardBodySchema } from "./request/rerun-scorecard.js";
import { RunScorecardBodySchema } from "./request/run-scorecard.js";

const scorecardIdParams = toJsonSchema(z.object({ id: z.string().describe("Scorecard id") }));

// OpenAPI descriptors for the scorecard routes — documentation only (no-op compilers; rule api-layer).
// Attached by scorecard.routes.ts as { schema: scorecardDocs.<key> }.
const docs = {
  submit: {
    summary: "Run a scorecard (batch eval)",
    description:
      "Async dataset×harness batch eval: returns 202 with the queued record; the batch runs in the background " +
      "(poll GET /scorecards/:id). Workspace-scoped; requires scorecards:run (member+). origin.source is decided " +
      "server-side from the credential (web/api/github-actions) — only client coordinates come from the body. " +
      "Selected judges score each case's trace as judge:<id> metrics. Budget caps admit with 402; queue " +
      "backpressure returns 429.",
    tags: ["scorecard"],
    body: toJsonSchema(RunScorecardBodySchema),
    response: {
      202: { description: "Batch accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  },
  retry: {
    summary: "Retry a scorecard's failed cases",
    description:
      "Creates a NEW scorecard that re-runs only the failed cases of a terminal batch; passing results are " +
      "carried over verbatim and origin.retryOf keeps the lineage (the source record is never mutated). " +
      "Requires scorecards:run (member+), workspace-scoped. 400 when the source is not terminal or nothing " +
      "failed. Optional ?class filter re-runs only that failure class's casualties.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    querystring: toJsonSchema(
      z.object({
        class: z
          .enum(["infra", "config", "harness", "agent"])
          .optional()
          .describe("Failure-class filter — re-run only this class's failed cases"),
      }),
    ),
    response: {
      202: { description: "Retry batch accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  rescoreUnmeasured: {
    summary: "Re-score retryable unmeasured judge scores in place",
    description:
      "Targeted transient-scoring recovery: re-runs ONLY the judges whose scores are retryable-unmeasured " +
      "(a judge LLM/transport blip), replacing their previous judge:<id> rows — no case is re-executed, and " +
      "the batch aggregates exactly as if scoring had succeeded the first time. Judge versions come from the " +
      "batch's own orchestration pins (never a silent latest upgrade). Non-judge unmeasured scores (in-job " +
      "grader failures) need a case re-run (/retry) and are returned as `skipped`. Requires scorecards:run " +
      "(member+), workspace-scoped. 400 when the batch has no per-case results yet.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: {
        description: "Recovery kicked off (rescoredJudges) + what a scoring pass cannot recover (skipped)",
        ...toJsonSchema(RescoreUnmeasuredResultSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  rerun: {
    summary: "Re-run a scorecard (full re-run)",
    description:
      "Creates a NEW scorecard that re-runs the ENTIRE case set of a terminal batch (full re-run), faithfully " +
      "reproducing the original submit (dataset+version, harness+ephemeral pins, grading plan, concurrency/" +
      "retries/trials, subset) so the two compare directly — while optionally adjusting the two run-config choices " +
      "made at submit time: the selected judges and the execution runtime (each unset field inherits the original). " +
      "Unlike retry it re-runs every case (no carry-over) and supports multi-trial batches. Lineage via " +
      "origin.retryOf; the source is never mutated, and the CI provenance (repo/PR) is deliberately dropped so a " +
      "manual re-run never supersedes the PR's in-flight batches. Requires scorecards:run (member+), " +
      "workspace-scoped. 400 when the source is not terminal.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    body: toJsonSchema(RerunScorecardBodySchema),
    response: {
      202: { description: "Re-run batch accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  },
  cancel: {
    summary: "Stop a running scorecard",
    description:
      "User-initiated stop of a queued/running batch: marks it `cancelled` (terminal, and — like superseded — " +
      "excluded from baseline/diff/leaderboard), stops firing the remaining cases, and force-frees the runtime of " +
      "the in-flight ones (managed backends are killed; self-hosted lease jobs are aborted on the runner's next " +
      "heartbeat). Requires scorecards:run (member+), workspace-scoped. 409 if the batch is already terminal; 404 " +
      "for a missing / other-workspace scorecard.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "The cancelled scorecard record", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  remove: {
    summary: "Delete a scorecard",
    description:
      "Permanently deletes a TERMINAL scorecard together with its fan-out child runs (hard delete — scorecards " +
      "are result records, not versioned artifacts, so there is no tombstone; the record disappears from " +
      "baseline/diff/leaderboard/trend). Allowed for the batch's creator or a workspace admin (scorecards:delete) " +
      "— enforced in the service. 409 while the batch is queued/running (stop it first); 404 for a missing / " +
      "other-workspace scorecard.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "Deleted (record + child runs removed)", ...toJsonSchema(DeleteScorecardResultSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  ingest: {
    summary: "Ingest external traces (push)",
    description:
      "Scores externally-produced TraceEvent[] uploads into a scorecard without running any harness. " +
      "Workspace-scoped; requires scorecards:run (member+). 202 with the queued record; selected judges are " +
      "applied to each uploaded trace. origin.source is decided server-side.",
    tags: ["scorecard"],
    body: toJsonSchema(IngestScorecardBodySchema),
    response: {
      202: { description: "Ingest accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  ingestPull: {
    summary: "Ingest traces from a trace platform (pull)",
    description:
      "Pulls per-runId traces from the tenant's observability platform (otel/mlflow/langfuse/langsmith/phoenix) " +
      "and scores them — no harness run. Source credentials come only via source.authSecret (a SecretStore key " +
      "name); no plaintext token in the body. Workspace-scoped; requires scorecards:run (member+). 202 with the " +
      "queued record.",
    tags: ["scorecard"],
    body: toJsonSchema(PullIngestBodySchema),
    response: {
      202: { description: "Pull-ingest accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List scorecards",
    description:
      "Lists the workspace's scorecard records. Requires scorecards:read (viewer+). The list view omits the " +
      "heavy per-case fields (scorecard/steps/runIds/export) — read GET /scorecards/:id for the detail.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        judge: z.string().optional().describe("Narrow to batches that applied this Agent Judge (any version)"),
        schedule: z.string().optional().describe("Narrow to the runs a schedule fired (its run history)"),
        dataset: z.string().optional().describe("Narrow to batches run on this dataset (any version)"),
        harness: z.string().optional().describe("Narrow to batches run with this harness (any version)"),
        team: z.string().optional().describe('Narrow to one owning team (id or key, e.g. "ENG")'),
      }),
    ),
    response: {
      200: {
        description: "Scorecard records (each with the served headlinePassRate)",
        ...toJsonSchema(ScorecardListResponseSchema),
      },
      ...errorResponses(401, 403),
    },
  },
  estimate: {
    summary: "Estimate a batch's cost and duration",
    description:
      "History-based preflight for a dataset×harness batch: per-case usd/duration medians from the last few " +
      "succeeded batches of the same pair. Honest when there is no history (basis.samples=0, no estimate " +
      "block). Requires scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        dataset: z.string().describe("Dataset id (required)"),
        harness: z.string().describe("Harness id (required)"),
        cases: z.string().optional().describe("Case-count override for the projection (number)"),
        concurrency: z.string().optional().describe("Concurrency override for the wall-clock projection (number)"),
      }),
    ),
    response: {
      200: { description: "Cost/time estimate", ...toJsonSchema(ScorecardEstimateResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  gate: {
    summary: "Release-gate a candidate against a baseline",
    description:
      "The CI-facing decision over a baseline↔candidate comparison: pass | block | blocked_missing | " +
      "not_comparable. TWO decisions are neither a pass nor a regression block, and neither may be read as a " +
      "green light: `not_comparable` (the comparison does not hold — policy mismatch, zero shared cases) and " +
      "`blocked_missing` (it held, but not over enough — cases the candidate never ran, metrics that vanished " +
      "or changed kind, scores that were not measurements). The gate is FAIL-CLOSED: a partial comparison " +
      "blocks unless the policy says comparability=allow_partial and states its tolerance " +
      "(maxMissingCases / maxMissingFraction); maxUnmeasuredFraction is enforced under either mode. When " +
      "either batch ran trials, the Fisher-gated trials diff is the authoritative regression signal and the " +
      "policy's zThreshold/minDelta set its bar; fdrAlpha adds the Benjamini-Hochberg correction across the " +
      "per-case tests (200 cases at alpha 0.05 otherwise manufacture ~10 false regressions, and under " +
      "maxRegressions 0 any one of them blocks the release). One thing precedes the statistics: a case the " +
      "CANDIDATE's verdict policy declared critical blocks on collapse or absence regardless of significance, " +
      "of maxRegressions, and of any missingness tolerance (reason critical_case_failed). The decision embeds " +
      "its effective policy (+digest) and is RECORDED on the candidate's ledger row for the gate audit. " +
      "Requires scorecards:run (member+).",
    tags: ["scorecard"],
    body: toJsonSchema(GateScorecardsBodySchema),
    response: {
      200: { description: "The recorded gate decision", ...toJsonSchema(GateDecisionSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  gateOverride: {
    summary: "Override a blocking gate decision",
    description:
      "Force a BLOCK through — recorded, never silent: who and why ride the decision and the gate audit " +
      "counts it (catalog R7). Only a blocking decision can be overridden — `block` and `blocked_missing` " +
      "alike, since knowingly shipping on an incomplete comparison is exactly the call that wants a name " +
      "against it (pass needs no force; not_comparable has nothing to force) — anything else is 409. " +
      "Requires scorecards:run (member+).",
    tags: ["scorecard"],
    params: scorecardIdParams,
    body: toJsonSchema(OverrideGateBodySchema),
    response: {
      200: { description: "The decision with its recorded override", ...toJsonSchema(GateDecisionSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  verifyManifest: {
    summary: "Verify a scorecard's reproducibility manifest",
    description:
      "Check every stamped digest against the CURRENT registry state: dataset bundle, resolved harness spec, " +
      "each judge spec, and the embedded verdict policy. `drifted` = the registry document is no longer " +
      "exactly what this batch evaluated; `unverifiable` = honest scope (a subset/grading-plan bundle is a " +
      "selection the record cannot replay). The caveat rides every response: digests are FNV identity stamps " +
      "against honest data, never tamper-evidence. 400 when the batch predates manifests. Requires " +
      "scorecards:read.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "Per-subject digest checks + the trust caveat", ...toJsonSchema(ManifestVerificationSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  flake: {
    summary: "Cross-batch flake index for a dataset",
    description:
      "The same (case, harness@version, runtime) key observed across succeeded batches, with the verdicts it " +
      "produced under each batch's OWN stamped policy — 'that test is just flaky' made refutable (T3/T9). " +
      "Entries list keys that produced BOTH outcomes (most unstable first, flakeScore = min(p,1−p)×2); an " +
      "unverdicted case (infra death, unmeasured-only) is no observation at all — an outage is not a flake. " +
      "Advisory only: nothing is auto-quarantined. Requires scorecards:read.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        dataset: z.string().describe("Dataset id (required)"),
        harness: z.string().optional().describe("Restrict to one harness id"),
      }),
    ),
    response: {
      200: { description: "Flake entries (most unstable first) + observed-key count", type: "object" },
      ...errorResponses(400, 401, 403),
    },
  },
  diff: {
    summary: "Diff two scorecards (baseline vs candidate)",
    description:
      "Baseline↔candidate comparison: per-metric mean deltas plus case-level regressions/improvements decided " +
      "by objective pass transitions. When either side ran trials, a statistical trial gate (two-proportion z, " +
      "?z sets the threshold, default 1.96 ≈ 95%) is included. Both scorecards must belong to this workspace " +
      "and be completed (400 if incomplete). Requires scorecards:read (viewer+).",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        baseline: z.string().describe("Baseline scorecard id (required)"),
        candidate: z.string().describe("Candidate scorecard id (required)"),
        z: z.string().optional().describe("Positive z threshold for the trial regression gate (default 1.96)"),
      }),
    ),
    response: {
      200: { description: "Diff result", ...toJsonSchema(ScorecardDiffResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  trend: {
    summary: "Scorecard trend over time",
    description:
      "Lays one (dataset, metric)'s succeeded scorecards out in time order and marks change/regression vs a " +
      "baseline (first/previous/<scorecardId>). Requires scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        dataset: z.string().describe("Dataset id (required)"),
        metric: z
          .string()
          .optional()
          .describe("Metric name (absent = the server resolves the highest-authority pass-rate metric present)"),
        harness: z.string().optional().describe("Restrict to one harness id"),
        from: z.string().optional().describe("ISO lower bound on createdAt"),
        to: z.string().optional().describe("ISO upper bound on createdAt"),
        baseline: z.string().optional().describe('"first" (default) | "previous" | a scorecard id'),
      }),
    ),
    response: {
      200: { description: "Trend series", ...toJsonSchema(ScorecardTrendResponseSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  leaderboard: {
    summary: "Per-benchmark leaderboard",
    description:
      "Ranks (harness × model) groups by metric score over one dataset (benchmark). window=latest (default) " +
      "represents each group by its newest scorecard; window=best by its highest score. Requires " +
      "scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        dataset: z.string().describe("Dataset id (required)"),
        metric: z
          .string()
          .optional()
          .describe("Metric name (absent = the server resolves the highest-authority pass-rate metric present)"),
        harness: z.string().optional().describe("Restrict to one harness id"),
        model: z.string().optional().describe("Restrict to one model"),
        judgeModel: z.string().optional().describe("Restrict to runs scored by this judge model"),
        window: z.string().optional().describe('"latest" (default) | "best"'),
      }),
    ),
    response: {
      200: { description: "Leaderboard", ...toJsonSchema(LeaderboardResponseSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  query: {
    summary: "Flexible analysis pivot over the workspace's scorecards",
    description:
      "Filter/group/pivot/measure the workspace's scorecards server-side (the engine behind the analyze dashboard " +
      "and saved Views): groupBy 0..2 dimensions, optional pivotBy column dimension, measure passRate|mean|count|" +
      "latest over a summary metric, viz table|bars (grid result) or line (time-bucketed series). Incomplete " +
      "batches (queued/running/superseded/cancelled) are excluded unless includeIncomplete. Requires " +
      "scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    body: toJsonSchema(AnalysisQueryBodySchema),
    response: {
      200: { description: "Analysis result (grid | line)", ...toJsonSchema(ScorecardAnalysisResponseSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  backfillModels: {
    summary: "Backfill the model axis of past scorecards",
    description:
      "Fills past succeeded scorecards that lack a models block from their stored traces (idempotent — " +
      "already-filled records are skipped). Requires scorecards:run (member+), workspace-scoped.",
    tags: ["scorecard"],
    response: {
      200: { description: "Backfill counters", ...toJsonSchema(BackfillModelsResponseSchema) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Get a scorecard",
    description:
      "Reads one scorecard record with the heavy detail (per-case results, steps, child run ids, trace-sink " +
      "export outcome). Workspace-scoped (another workspace's record reads 404 — no existence leak); requires " +
      "scorecards:read (viewer+). A running batch carries a derived etaSeconds.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "The scorecard record", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  analysisBundle: {
    summary: "Get a scorecard's offloaded analysis bundle",
    description:
      "Fetches the self-contained analysis artifact (ScorecardRecord.analysisRef) server-side and returns it as " +
      "one JSON document: aggregate summary + per-case verdicts/scores/failures. 404 when the record has no " +
      "downloadable analysis artifact (no ArtifactStore configured, offload failed, or a non-http ref). Requires " +
      "scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "The analysis bundle", ...toJsonSchema(ScorecardAnalysisBundleResponseSchema) },
      ...errorResponses(401, 403, 404, 502),
    },
  },
  move: teamMoveDocs({
    resource: "scorecard",
    tag: "scorecard",
    idDescription: "Scorecard id",
    action: "scorecards:run",
    extra:
      "A scorecard is the evidence a capability produced, and it is read through the same team lens the " +
      "capability is — so handing a harness or dataset to another team does not drag its past results along; " +
      "re-file those here. Results and scores are untouched.",
  }),
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const scorecardDocs: Record<keyof typeof docs, FastifySchema> = docs;
