import { IngestScorecardBodySchema, PullIngestBodySchema } from "@everdict/application-control";
import { BackfillModelsResponseSchema } from "@everdict/contracts/wire";
import { DeleteScorecardResultSchema } from "@everdict/contracts/wire";
import { LeaderboardResponseSchema } from "@everdict/contracts/wire";
import { ScorecardDiffResponseSchema } from "@everdict/contracts/wire";
import { ScorecardEstimateResponseSchema } from "@everdict/contracts/wire";
import { ScorecardListResponseSchema } from "@everdict/contracts/wire";
import { ScorecardTrendResponseSchema } from "@everdict/contracts/wire";
import { ScorecardResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
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
  rerun: {
    summary: "Re-run a scorecard (full re-run)",
    description:
      "Creates a NEW scorecard that re-runs the ENTIRE case set of a terminal batch (전체 재실행), faithfully " +
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
      }),
    ),
    response: {
      200: { description: "Scorecard records", ...toJsonSchema(ScorecardListResponseSchema) },
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
        metric: z.string().optional().describe('Metric name (default "judge")'),
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
        metric: z.string().optional().describe('Metric name (default "judge")'),
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
} satisfies Record<string, FastifySchema>;

// Export widened to FastifySchema: literal response-status keys would otherwise constrain reply.code()
// in the handlers (doc-only — the schema must never change route typing/behavior).
export const scorecardDocs: Record<keyof typeof docs, FastifySchema> = docs;
