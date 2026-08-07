import { IngestScorecardBodySchema, PullIngestBodySchema, originSource } from "@everdict/application-control";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { teamCeiling, teamForNew, visibleTeamsFor } from "../../common/team-scope.js";
import { type McpToolContext, fail, ok, plain, resolveTeam, run, runForTeam } from "../mcp-context.js";
import { moveToolDescription } from "../team-move.js";
import { AnalysisDimensionSchema } from "./request/analysis-query.js";
import { serveScorecard, serveScorecardListItem } from "./serve.js";

// The owning team a JSON body names, if any. The shared body schemas do not carry `teamId` (it is transport
// metadata, not ingest content), so both transports read it off the raw object before validation.
function teamIdIn(body: unknown): string | undefined {
  const named = (body as { teamId?: unknown } | null)?.teamId;
  return typeof named === "string" ? named : undefined;
}

// Scorecard resource MCP tools — the MCP twin of scorecard.routes.ts (same ScorecardService core, second transport).
export function registerScorecardTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws, agent } = ctx;

  if (deps.scorecardService) {
    const scorecards = deps.scorecardService;
    server.registerTool(
      "run_scorecard",
      {
        description:
          "Run a dataset against harness@version and aggregate a scorecard (async — returns a queued record, then poll with get_scorecard). If runtime is given, execute on that runtime.",
        inputSchema: {
          dataset_id: z.string(),
          dataset_version: z.string().optional(),
          harness_id: z.string(),
          harness_version: z.string().optional(),
          runtime: z
            .string()
            .optional()
            .describe(
              'tenant Runtime id (placement.target) or self runner target; a comma-separated list SHARDS the batch round-robin across runtimes; "auto" expands to every registered runtime. If absent, 400 per the deployment policy',
            ),
          harness_pins: z
            .record(z.string())
            .optional()
            .describe(
              "submit-time ephemeral pins (slot→image, registry unchanged) — for CI PR image swaps. Recorded in origin",
            ),
          judges: z
            .array(z.object({ id: z.string(), version: z.string().optional() }))
            .optional()
            .describe("Agent Judges to apply to the trace (version defaults to latest)"),
          graders: z
            .array(z.object({ id: z.string(), config: z.record(z.unknown()).optional() }))
            .min(1)
            .optional()
            .describe(
              "run-time grading plan (GraderSpec[] {id, config?}) — replaces every case's default graders for THIS batch; the dataset stays untouched",
            ),
          judge: z
            .object({ provider: z.enum(["openai", "anthropic"]).optional(), model: z.string() })
            .optional()
            .describe(
              "inline judge-grader scoring model override for this batch (unset = workspace default) — HTTP parity",
            ),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(512)
            .optional()
            .describe(
              "number of cases this batch keeps in flight (parallelism; actual placement is capacity-governed by the scheduler). Defaults to the service default (=4) if unset",
            ),
          retries: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .describe(
              "transient dispatch retries per case (throw-only; a failing eval result is never retried). Default 1",
            ),
          trials: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "run each case N times for pass@k / flakiness (fans out N dispatches per case). Default 1; the scorecard detail carries a derived trialSummary — HTTP parity",
            ),
          cases: z
            .object({
              ids: z.array(z.string().min(1)).min(1).optional(),
              tags: z.array(z.string().min(1)).min(1).optional(),
              limit: z.number().int().min(1).max(10_000).optional(),
            })
            .optional()
            .describe(
              "partial run — only a subset of the full dataset (explicit ids → tags any-match → limit first N, applied in that order)",
            ),
          trace_sink: z
            .string()
            .min(1)
            .optional()
            .describe(
              'per-batch trace-sink override: a configured workspace sink name, or "none" to suppress export for this batch. Unset = the harness own selection — HTTP parity',
            ),
          oom_auto_boost: z
            .boolean()
            .optional()
            .describe(
              "in-batch OOM auto-boost (opt-in — every boost re-runs the case): an OOM_KILLED case re-dispatches with doubled job-only memory up to the cap",
            ),
          team_id: z
            .string()
            .optional()
            .describe(
              'the team this batch belongs to — id or key ("ENG"). A team you are not on is refused. Absent: the harness\'s owning team, else your own',
            ),
          origin: z
            .object({
              repo: z.string().optional(),
              sha: z.string().optional(),
              ref: z.string().optional(),
              prNumber: z.number().int().optional(),
              runUrl: z.string().optional(),
            })
            .optional()
            .describe("origin coordinates (commit/PR/CI run) — source is decided by the server"),
        },
      },
      ({
        dataset_id,
        dataset_version,
        harness_id,
        harness_version,
        harness_pins,
        runtime,
        judges,
        graders,
        judge,
        concurrency,
        retries,
        trials,
        cases,
        trace_sink,
        oom_auto_boost,
        team_id,
        origin,
      }) =>
        // Owner resolved (id or key) and gated before the work starts — the same two steps the HTTP route takes,
        // through the same helper, so an agent cannot file a batch under a team its creator is not on.
        runForTeam(ctx, "scorecards:run", team_id, async (owner) =>
          ok(
            await scorecards.submit({
              tenant: ws,
              submittedBy: principal.subject, // clone private-repo cases via my personal connection
              // Named → the owner; unnamed → the service inherits the harness's team, else this fallback.
              ...(team_id !== undefined && owner !== undefined ? { teamId: owner } : {}),
              ...(owner !== undefined ? { submitterTeamId: owner } : {}),
              dataset: { id: dataset_id, version: dataset_version ?? "latest" },
              harness: {
                id: harness_id,
                version: harness_version ?? "latest",
                ...(harness_pins ? { pins: harness_pins } : {}),
              },
              origin: {
                source: originSource(principal.via),
                ...(origin ?? {}),
                // P3 causedBy: an agent-driven MCP session stamps the run behind the turn — the batch and
                // its children join the demand graph as that run's downstream work.
                ...(agent?.runId !== undefined ? { causedByRunId: agent.runId } : {}),
              },
              judges: (judges ?? []).map((j) => ({ id: j.id, version: j.version ?? "latest" })),
              ...(graders ? { graders } : {}),
              ...(judge ? { judge } : {}),
              ...(runtime ? { runtime } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(retries !== undefined ? { retries } : {}),
              ...(trials !== undefined ? { trials } : {}),
              ...(cases ? { cases } : {}),
              ...(trace_sink ? { traceSink: trace_sink } : {}),
              ...(oom_auto_boost ? { oomAutoBoost: true } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "retry_scorecard",
      {
        description:
          "Retry a finished batch's FAILED cases as a new scorecard — passing results are carried over verbatim (full comparable case set), origin.retryOf keeps the lineage. The source record is never mutated.",
        inputSchema: {
          id: z.string().describe("source scorecard id (must be succeeded/failed)"),
          failure_class: z
            .enum(["infra", "config", "harness", "agent"])
            .optional()
            .describe(
              "re-run only this failure class (e.g. infra after a cluster incident) — agent FAILs stay carried",
            ),
        },
      },
      ({ id, failure_class }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.retryFailed({
              tenant: ws,
              id,
              submittedBy: principal.subject,
              ...(failure_class ? { failureClass: failure_class } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "rerun_scorecard",
      {
        description:
          "Re-run a finished batch's ENTIRE case set as a new scorecard (전체 재실행), faithfully reproducing the original submit (dataset+version, harness+pins, grading plan, trials) so the two compare directly — while optionally overriding the run-config knobs: WHO runs it (judges, runtime) and HOW it is dispatched (concurrency, retries, subset via cases). Each unset field inherits the original; scoring is reproduced verbatim (never overridden). Async (poll with get_scorecard). Multi-trial IS supported here. Lineage via origin.retryOf; the source record is never mutated. For recovering only the FAILED cases (carry the passing ones over) use retry_scorecard instead.",
        inputSchema: {
          id: z.string().describe("source scorecard id (must be succeeded/failed)"),
          judges: z
            .array(z.object({ id: z.string(), version: z.string().default("latest") }))
            .optional()
            .describe(
              "selected Agent Judges override [{id, version?}] — unset inherits the original selection, [] re-runs with no judges",
            ),
          runtime: z
            .string()
            .min(1)
            .optional()
            .describe(
              "execution target override (a registered runtime id or self:* runner) — unset inherits the original",
            ),
          concurrency: z
            .number()
            .int()
            .min(1)
            .max(512)
            .optional()
            .describe("dispatch concurrency override (max cases at once) — unset inherits the original"),
          retries: z
            .number()
            .int()
            .min(0)
            .max(5)
            .optional()
            .describe("per-case transient retry override — unset inherits the original"),
          cases: z
            .object({
              ids: z.array(z.string().min(1)).min(1).optional(),
              tags: z.array(z.string().min(1)).min(1).optional(),
              limit: z.number().int().min(1).max(10_000).optional(),
            })
            .optional()
            .describe("subset override (ids → tags → limit) — unset re-runs the SAME subset the source ran"),
        },
      },
      ({ id, judges, runtime, concurrency, retries, cases }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.rerun({
              tenant: ws,
              id,
              submittedBy: principal.subject,
              ...(judges ? { judges } : {}),
              ...(runtime ? { runtime } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(retries !== undefined ? { retries } : {}),
              ...(cases ? { cases } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "cancel_scorecard",
      {
        description:
          "Stop a running/queued batch (user cancel): mark it cancelled (terminal, excluded from baseline/diff/leaderboard), stop firing the remaining cases, and force-free the runtime of the in-flight ones (managed backends killed; self-hosted lease jobs aborted on the runner's next heartbeat). Already-terminal → conflict; other workspace / missing → NOT_FOUND.",
        inputSchema: { id: z.string().describe("scorecard id to stop (must be queued/running)") },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () => ok(serveScorecard(await scorecards.cancel({ tenant: ws, id })))),
    );

    server.registerTool(
      "delete_scorecard",
      {
        description:
          "Permanently delete a TERMINAL scorecard and its fan-out child runs (hard delete — it disappears from baseline/diff/leaderboard/trend). Only the batch's creator or a workspace admin. Still queued/running → conflict (cancel it first); other workspace / missing → NOT_FOUND.",
        inputSchema: { id: z.string().describe("scorecard id to delete (must be terminal)") },
      },
      ({ id }) => plain(async () => ok(await scorecards.delete({ principal, id }))),
    );

    server.registerTool(
      "list_scorecards",
      {
        description:
          "This workspace's scorecards (summary only — excludes heavy per-case results). Narrow by dataset or " +
          "harness to see what a capability has been evaluated on over time — that is the comparison to make " +
          "before claiming something regressed.",
        inputSchema: {
          judge: z.string().optional().describe("narrow to batches that applied this Agent Judge (any version)"),
          schedule: z.string().optional().describe("narrow to the runs a schedule fired (its run history)"),
          dataset: z.string().optional().describe("narrow to batches run on this dataset (any version)"),
          harness: z.string().optional().describe("narrow to batches run with this harness (any version)"),
          team: z.string().optional().describe('narrow to one team\'s batches — id or key ("ENG")'),
        },
      },
      ({ judge, schedule, dataset, harness, team }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            (
              await scorecards.list(ws, {
                ...(schedule
                  ? { scheduleId: schedule }
                  : judge
                    ? { judge }
                    : { ...(dataset !== undefined ? { dataset } : {}), ...(harness !== undefined ? { harness } : {}) }),
                // `team` COMBINES with the narrows above rather than replacing them — "of these, which are ours".
                ...(team !== undefined ? { teamId: await resolveTeam(ctx, team) } : {}),
                // Same ownership ceiling the BFF list stays under — an agent acts as its creator, so it sees that
                // person's teams and no more. The narrow above never reaches past this ceiling.
                ...(await teamCeiling(ctx.deps, principal)),
              })
            ).map(serveScorecardListItem), // BFF parity — the ranked headline rides the MCP list too
          ),
        ),
    );

    server.registerTool(
      "rescore_unmeasured_scores",
      {
        description:
          "Re-score a scorecard's retryable-unmeasured judge scores in place (transient judge LLM/transport blips) — no case re-execution; judge versions come from the batch's own pins. Non-judge unmeasured scores need a case re-run (retry) and come back as `skipped`.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () =>
          ok(await scorecards.rescoreUnmeasured({ tenant: ws, id, submittedBy: principal.subject })),
        ),
    );

    server.registerTool(
      "move_scorecard",
      {
        description: moveToolDescription(
          "Re-file a scorecard under another team. A scorecard is the EVIDENCE a capability produced and is " +
            "read through the same team lens, so handing a harness or dataset to another team does not drag " +
            "its past results along — move those here. Results and scores are untouched.",
        ),
        inputSchema: {
          id: z.string(),
          team: z.string().describe('the destination team — id or key ("ENG")'),
        },
      },
      ({ id, team }) =>
        // The service authorizes BOTH teams, so this runs unguarded here rather than re-asking half the question.
        plain(async () =>
          ok(
            await scorecards.moveToTeam({
              principal,
              id,
              teamId: await resolveTeam(ctx, team),
              ...(ctx.agent?.agentId !== undefined ? { agent: ctx.agent } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "get_scorecard",
      {
        description: "A full scorecard (including per-case results). Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:read", async () => {
          const record = await scorecards.getForDisplay(id); // BFF parity — the agent gets openable artifact refs too
          if (
            !record ||
            record.tenant !== ws ||
            !ownedByVisibleTeam(record, await visibleTeamsFor(ctx.deps, principal))
          )
            return fail("NOT_FOUND: scorecard not found.");
          return ok(serveScorecard(record));
        }),
    );

    server.registerTool(
      "diff_scorecards",
      {
        description:
          "Compare two scorecards (baseline vs candidate) → metric delta + per-case regression/improvement. Both must be completed in this workspace. When either ran trials, the result also carries a statistically-gated 'trials' diff (pass@k regression)",
        inputSchema: {
          baseline: z.string(),
          candidate: z.string(),
          z: z
            .number()
            .positive()
            .optional()
            .describe("confidence threshold for the trial regression gate (default 1.96 ≈ 95%; only used with trials)"),
        },
      },
      ({ baseline, candidate, z: zThreshold }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.diff(ws, baseline, candidate, {
              ...(zThreshold !== undefined ? { zThreshold } : {}),
              ...(await teamCeiling(ctx.deps, principal)),
            }),
          ),
        ),
    );

    server.registerTool(
      "estimate_scorecard",
      {
        description:
          "Cost/time preflight for a dataset×harness batch — per-case usd/duration medians from the last few succeeded batches, projected to an estimate (usd, wall seconds). Honest empty when there is no history — HTTP parity (GET /scorecards/estimate).",
        inputSchema: {
          dataset_id: z.string(),
          harness_id: z.string(),
          cases: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("case count to project (default: the dataset's full size)"),
          concurrency: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("assumed batch parallelism (default: service default)"),
        },
      },
      ({ dataset_id, harness_id, cases, concurrency }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.estimate({
              tenant: ws,
              dataset: dataset_id,
              harness: harness_id,
              ...(cases !== undefined ? { cases } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
            }),
          ),
        ),
    );

    server.registerTool(
      "leaderboard_scorecards",
      {
        description:
          "(harness × model) ranking for one dataset (benchmark) — descending by metric. window=latest(default)|best. Optional harness/model/judge_model filters (judge_model = fair comparison among the same grader).",
        inputSchema: {
          dataset: z.string(),
          metric: z.string().optional(),
          harness: z.string().optional(),
          model: z.string().optional(),
          judge_model: z.string().optional(),
          window: z.enum(["latest", "best"]).optional(),
        },
      },
      ({ dataset, metric, harness, model, judge_model, window }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.leaderboard(ws, {
              datasetId: dataset,
              ...(metric ? { metric } : {}), // absent = preferredMetric over the data (BFF parity)
              ...(harness ? { harnessId: harness } : {}),
              ...(model ? { model } : {}),
              ...(judge_model ? { judgeModel: judge_model } : {}),
              window: window ?? "latest",
              ...(await teamCeiling(ctx.deps, principal)),
            }),
          ),
        ),
    );

    server.registerTool(
      "query_scorecards",
      {
        description:
          "Flexible analysis pivot over the workspace's scorecards (the engine behind the analyze dashboard/Views): " +
          "filter, group by 0..2 dimensions, optional pivot column, measure passRate|mean|count|latest over a " +
          "summary metric. viz table|bars → grid rows; viz line → time-bucketed series (x = the time dimension in " +
          "group_by, one series per non-time dimension). Incomplete batches are excluded unless include_incomplete.",
        inputSchema: {
          group_by: z
            .array(AnalysisDimensionSchema)
            .max(2)
            .optional()
            .describe("0..2 row dimensions (default [harness])"),
          pivot_by: AnalysisDimensionSchema.optional().describe("optional column dimension → matrix"),
          metric: z.string().optional().describe("summary metric name (unset = each card's first summary row)"),
          measure: z.enum(["passRate", "mean", "count", "latest"]).optional().describe("default passRate"),
          viz: z.enum(["table", "bars", "line"]).optional().describe("table|bars = grid, line = time series"),
          sort_by: z.enum(["measure", "label"]).optional().describe("grid row sort key (default measure)"),
          sort_dir: z.enum(["asc", "desc"]).optional().describe("default desc"),
          search: z.string().optional().describe("free-text filter over dataset/harness/model/origin/owner"),
          include_incomplete: z.boolean().optional(),
          filters: z
            .object({
              dataset: z.array(z.string()).optional(),
              harness: z.array(z.string()).optional(),
              model: z.array(z.string()).optional(),
              judgeModel: z.array(z.string()).optional(),
              status: z.array(z.string()).optional(),
              owner: z.array(z.string()).optional(),
              originSource: z.array(z.string()).optional(),
              from: z.string().optional().describe("createdAt >= (ISO date)"),
              to: z.string().optional().describe("createdAt <= (ISO date, inclusive)"),
            })
            .optional(),
        },
      },
      ({ group_by, pivot_by, metric, measure, viz, sort_by, sort_dir, search, include_incomplete, filters }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.analysis(
              ws,
              {
                filters: filters ?? {},
                groupBy: group_by ?? ["harness"],
                ...(pivot_by ? { pivotBy: pivot_by } : {}),
                ...(metric ? { metric } : {}),
                measure: measure ?? "passRate",
                sort: { by: sort_by ?? "measure", dir: sort_dir ?? "desc" },
                ...(search ? { search } : {}),
                viz: viz ?? "table",
                ...(include_incomplete !== undefined ? { includeIncomplete: include_incomplete } : {}),
              },
              await visibleTeamsFor(ctx.deps, principal),
            ),
          ),
        ),
    );

    server.registerTool(
      "get_scorecard_analysis",
      {
        description:
          "Get a scorecard's offloaded analysis bundle (analysisRef) as one JSON document: aggregate summary + " +
          "per-case verdicts/scores/failures — the case-level deep dive without reading every child run. 404 when " +
          "the record has no downloadable analysis artifact.",
        inputSchema: { id: z.string().describe("Scorecard id") },
      },
      ({ id }) =>
        run(principal, "scorecards:read", async () =>
          ok(await scorecards.analysisBundle(ws, id, await visibleTeamsFor(ctx.deps, principal))),
        ),
    );

    server.registerTool(
      "backfill_scorecard_models",
      {
        description:
          "Backfill the observed model from stored traces into past succeeded scorecards that lack models (idempotent). Use to include past runs on the leaderboard.",
        inputSchema: {},
      },
      () => run(principal, "scorecards:run", async () => ok(await scorecards.backfillModels(ws))),
    );

    server.registerTool(
      "ingest_scorecard",
      {
        description:
          "Upload externally produced traces (TraceEvent[]) into a scorecard (harness not run). dataset/harness are OPTIONAL labels — omit both to evaluate the uploaded traces directly (each trace = one case, judges only). body=IngestScorecard JSON {dataset?,harness?,traces:[{caseId,trace}],judges?}",
        inputSchema: { body: z.string().describe("IngestScorecard JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid IngestScorecard JSON.");
          }
          const result = IngestScorecardBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // Same owner rule as the HTTP twin: `teamId` may ride in the JSON (the body schema strips it, so it
          // is read off the raw object), else the caller's team.
          const owner = await teamForNew(principal, ctx.deps, teamIdIn(parsed));
          return ok(
            await scorecards.ingest({
              tenant: ws,
              submittedBy: principal.subject,
              ...(owner.teamId !== undefined ? { teamId: owner.teamId } : {}),
              ...result.data,
            }),
          );
        }),
    );

    server.registerTool(
      "pull_scorecard",
      {
        description:
          "Pull per-runId traces from the tenant's observability platform (otel|mlflow|langfuse|langsmith|phoenix) into a scorecard (harness not run). dataset/harness are OPTIONAL labels — omit both to evaluate the pulled traces directly (each trace = one case, judges only). source is EITHER a registered workspace source by name {name} (register once in Settings › Observability, then pull by name) OR an inline config {kind,endpoint,authSecret?,project?[required for phoenix]}. body=PullIngest JSON {dataset?,harness?,source,runs:[{caseId,runId}],judges?}",
        inputSchema: { body: z.string().describe("PullIngest JSON") },
      },
      ({ body }) =>
        run(principal, "scorecards:run", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            return fail("BAD_REQUEST: not a valid PullIngest JSON.");
          }
          const result = PullIngestBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          const owner = await teamForNew(principal, ctx.deps, teamIdIn(parsed));
          return ok(
            await scorecards.ingestPull({
              tenant: ws,
              submittedBy: principal.subject,
              ...(owner.teamId !== undefined ? { teamId: owner.teamId } : {}),
              ...result.data,
            }),
          );
        }),
    );
  }
}
