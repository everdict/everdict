import { IngestScorecardBodySchema, PullIngestBodySchema } from "@everdict/application-control";
import { GateDecisionSchema, ManifestVerificationSchema, ScorecardStatusSchema } from "@everdict/contracts";
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
import { AnalysisQueryBodySchema } from "./request/analysis-query.js";
import { GateScorecardsBodySchema, OverrideGateBodySchema } from "./request/gate-scorecards.js";
import { RerunScorecardBodySchema } from "./request/rerun-scorecard.js";
import { RetryCasesBodySchema } from "./request/retry-cases.js";
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
      "This is the FORK — use POST /scorecards/:id/retry-cases to repair the record you have. " +
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
  retryCases: {
    summary: "Retry named cases inside this scorecard",
    description:
      "Re-runs the named cases IN PLACE: the same scorecard, a new attempt per case, and the attempt each " +
      "one replaces preserved on the record with its own result and commit receipt. The newest attempt is " +
      "the case's answer and `retrySummary` says how many times each case has run — where POST /retry " +
      "forks a NEW scorecard and leaves this one carrying a failure nobody can repair. The cases re-run " +
      "under the batch's OWN sealed plan (its dataset documents, grading plan, environments and harness " +
      "closure at the versions it recorded), so a retry measures the same experiment. Requires " +
      "scorecards:run (member+), workspace-scoped. 400 when the batch has no results, when a named case is " +
      "not in it, or when a case that already reached a verdict is retried with no `reason` — that is " +
      "allowed and is never silent. 409 when the batch is still running or another retry pass owns it.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    body: toJsonSchema(RetryCasesBodySchema),
    response: {
      200: { description: "Retry settled", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
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
  counts: {
    summary: "Count the workspace's scorecards per group",
    description:
      "How many batches fall in each bucket under the SAME filter GET /scorecards takes — the headers of a " +
      "grouped list, and its total. `groupBy` is day | status | harness | dataset | creator; `day` is " +
      "the stored instant's UTC calendar day, which is the key the day grouping buckets a row under (a " +
      "header counted in one timezone over rows bucketed in another disagrees with itself twice a day). " +
      "Buckets with no rows are absent, and `key: null` is the unset bucket (no creator). A paged " +
      "screen cannot get these numbers from its own rows — counting what it received only reports the page " +
      "size back. Requires scorecards:read.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        groupBy: z.enum(["day", "status", "harness", "dataset", "creator"]),
        judge: z.string().optional(),
        schedule: z.string().optional(),
        dataset: z.string().optional(),
        harness: z.string().optional(),
        status: ScorecardStatusSchema.optional(),
        runtime: z.string().optional(),
        creator: z.string().optional(),
        day: z.string().optional(),
        q: z.string().optional(),
      }),
    ),
    response: {
      200: {
        description: "Per-group counts and their total",
        ...toJsonSchema(
          z.object({
            groupBy: z.enum(["day", "status", "harness", "dataset", "creator"]),
            groups: z.array(z.object({ key: z.string().nullable(), count: z.number().int() })),
            total: z.number().int(),
          }),
        ),
      },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List scorecards",
    description:
      "Lists the workspace's scorecard records, newest first (createdAt desc, id desc breaking a tie). " +
      "Requires scorecards:read (viewer+). The list view omits the heavy per-case fields " +
      "(scorecard/steps/runIds/export) — read GET /scorecards/:id for the detail. " +
      "WITHOUT `limit` this answers the whole collection, as it always has. WITH it you get a page, and the " +
      "cursor for the next one is the LAST ROW YOU DREW: pass its createdAt and id as `beforeCreatedAt` + " +
      "`beforeId`. Both halves or neither — the ordering is total only with the id, so a cursor carrying the " +
      "timestamp alone repeats or skips a row wherever two batches share an instant. There is no opaque " +
      "token because there is nothing to hide: the ordering is this endpoint's contract. For the totals a " +
      "page cannot know, read GET /scorecards/counts under the same filter.",
    tags: ["scorecard"],
    querystring: toJsonSchema(
      z.object({
        judge: z.string().optional().describe("Narrow to batches that applied this Agent Judge (any version)"),
        schedule: z.string().optional().describe("Narrow to the runs a schedule fired (its run history)"),
        dataset: z.string().optional().describe("Narrow to batches run on this dataset (any version)"),
        harness: z.string().optional().describe("Narrow to batches run with this harness (any version)"),
        status: ScorecardStatusSchema.optional().describe("Narrow to one batch status"),
        runtime: z.string().optional().describe("Narrow to the runtime the batch ran on"),
        creator: z.string().optional().describe("Narrow to the submitter (subject)"),
        day: z.string().optional().describe("One UTC calendar day, YYYY-MM-DD — the day grouping's own key"),
        q: z.string().optional().describe("Free text over the batch id and the dataset/harness ids it names"),
        limit: z.coerce.number().optional().describe("Page size (1..200). Absent = the whole collection"),
        beforeCreatedAt: z.string().optional().describe("Cursor: the last drawn row's createdAt"),
        beforeId: z.string().optional().describe("Cursor: the last drawn row's id (required with the above)"),
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
      "Verify the manifest facet by facet against the CURRENT registry state: the dataset composite, the " +
      "per-case content seals (verified individually — a subset never blocks them), the effective grading " +
      "(the persisted plan, or per-case registry defaults), the resolved harness spec, each judge spec plus " +
      "its CLOSURE (the sealed model/rubric/delegated-harness re-resolved through the same sealer submit " +
      "used), the runtime judge configuration, and the embedded verdict policy. `drifted` = the registry " +
      "document is no longer exactly what this batch evaluated (closure facets: re-resolving today would " +
      "not judge identically); `unverifiable` is confined to what genuinely is not replayable — the " +
      "selection-keyed composites on subset/plan runs and 'unresolved' closure seals. Each digest check " +
      "runs under the stamp's own algorithm — `sha256:` stamps are collision-resistant, while pre-sha256 " +
      "bare-hex FNV stamps stay verifiable but remain identity against honest data, never tamper-evidence; " +
      "the caveat rides every response and says which this record carried. 400 when the batch predates " +
      "manifests. Requires scorecards:read.",
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
      "scorecards:read (viewer+). A running batch carries a derived etaSeconds. `caseRuns` is the " +
      "receipt-canonical (case, trial) → child run map: the only correct way to open a case's execution " +
      "detail, since a retried case has several child runs and only the receipted one is this batch's evidence.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    response: {
      200: { description: "The scorecard record", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  report: {
    summary: "Export the scorecard as a citable report",
    description:
      "The number with everything that makes it a number: the dataset version and digest, the harness version and " +
      "spec digest, the manifest era, the scoring semantics as data (official · proxy · unstated), the metric summary " +
      "and per-case verdicts. REFUSED (400) when the dataset scores as a proxy, or states no semantics, unless " +
      "?allowProxy=true — the export then says so in its header. Only a succeeded batch has a number to cite. " +
      "Requires scorecards:read (viewer+), workspace-scoped.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    querystring: toJsonSchema(
      z.object({
        allowProxy: z.enum(["true", "false"]).optional().describe("Export a proxy / unstated scoring, labelled"),
      }),
    ),
    response: { 200: { description: "The citable report" }, ...errorResponses(400, 401, 403, 404) },
  },
  analysisBundle: {
    summary: "Get a scorecard's offloaded analysis bundle",
    description:
      "Fetches the self-contained analysis artifact (ScorecardRecord.analysisRef) server-side and returns it as " +
      "one JSON document: aggregate summary + per-case verdicts/scores/failures. ?revision=N returns that scoring " +
      "revision's FROZEN artifact (each pass freezes its own bundle — immutable history) instead of the current " +
      "bundle. 404 when the record has no downloadable analysis artifact (no ArtifactStore configured, offload " +
      "failed, a non-http ref, or the requested revision has no frozen artifact). Requires scorecards:read " +
      "(viewer+), workspace-scoped.",
    tags: ["scorecard"],
    params: scorecardIdParams,
    querystring: toJsonSchema(
      z.object({
        revision: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe("Scoring revision whose frozen analysis artifact to return (default: the current bundle)"),
      }),
    ),
    response: {
      200: { description: "The analysis bundle", ...toJsonSchema(ScorecardAnalysisBundleResponseSchema) },
      ...errorResponses(401, 403, 404, 502),
    },
  },
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const scorecardDocs: Record<keyof typeof docs, FastifySchema> = docs;
