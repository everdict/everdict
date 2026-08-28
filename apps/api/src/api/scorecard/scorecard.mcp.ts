import { IngestScorecardBodySchema, PullIngestBodySchema, originSource } from "@everdict/application-control";
import { NotFoundError } from "@everdict/contracts";
import { type Action, authorize, ownedByVisibleTeam } from "@everdict/domain";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { teamCeiling, visibleTeamsFor } from "../../common/team-scope.js";
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
// ── WHOSE BATCH IS THIS — THE MCP HALF (arch-review 119) ───────────────────────────────────────────
//
// The HTTP twin's `scorecardOwner`, spelled here because the two transport files may not import each other.
// Every OPERATIONAL tool gated a bare `scorecards:run` while `get_scorecard` was ceilinged, so an agent
// acting for a member of another team — answered NOT_FOUND for the same id on read — could stop a running
// batch, RE-DRIVE it (real compute on somebody else's evidence), rescore it, or override its gate decision.
// Reading was narrower than writing, which is the inversion the axis exists to prevent; docs/auth.md names
// results by name.
//
// ⚠️ Called INSIDE `run`, never before it. `run` authorizes the ACTION first, so a viewer is refused for the
// reason that is true — the role — without this file reading a record. Resolving ownership ahead of that
// answers NOT_FOUND to somebody whose actual problem is permission, and the HTTP twin's suite pins that
// ordering by name ("gated before the service runs").
//
// `undefined` means "not this caller's to touch", answered NOT_FOUND — the same answer the read gives,
// because a refusal that leaks existence is what team privacy is for.
async function assertBatchReachable(ctx: McpToolContext, action: Action, id: string): Promise<void> {
  const record = await ctx.deps.scorecardService?.get(id);
  if (!record || record.tenant !== ctx.ws) throw new NotFoundError("NOT_FOUND", { id }, "scorecard not found.");
  if (!ownedByVisibleTeam(record, await visibleTeamsFor(ctx.deps, ctx.principal)))
    throw new NotFoundError("NOT_FOUND", { id }, "scorecard not found.");
  authorize(ctx.principal, action, record.teamId === undefined ? {} : { teamId: record.teamId });
}

export function registerScorecardTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws, agent } = ctx;

  if (deps.scorecardService) {
    const scorecards = deps.scorecardService;
    server.registerTool(
      "run_scorecard",
      {
        annotations: { readOnlyHint: false },
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
          critical_cases: z
            .array(z.union([z.object({ caseId: z.string().min(1) }), z.object({ prefix: z.string().min(1) })]))
            .min(1)
            .optional()
            .describe(
              'cases this batch declares CRITICAL ({caseId} = one case, {prefix} = a family like "auth/") — composed into its verdict policy, so a release gate over this batch blocks on their collapse regardless of statistical significance and regardless of maxRegressions. Unset = the gate is pure arithmetic — HTTP parity',
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
        critical_cases,
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
              submitterRoles: principal.roles, // constitution seed (ground_truth declarations are admin-only)
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
              ...(critical_cases ? { criticalCases: critical_cases } : {}),
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
        annotations: { readOnlyHint: false },
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
        run(principal, "scorecards:run", async () => {
          await assertBatchReachable(ctx, "scorecards:run", id);
          return ok(
            await scorecards.retryFailed({
              tenant: ws,
              id,
              submittedBy: principal.subject,
              ...(failure_class ? { failureClass: failure_class } : {}),
            }),
          );
        }),
    );

    server.registerTool(
      "rerun_scorecard",
      {
        annotations: { readOnlyHint: false },
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
        run(principal, "scorecards:run", async () => {
          await assertBatchReachable(ctx, "scorecards:run", id);
          return ok(
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
          );
        }),
    );

    server.registerTool(
      "cancel_scorecard",
      {
        annotations: { readOnlyHint: false },
        description:
          "Stop a running/queued batch (user cancel): mark it cancelled (terminal, excluded from baseline/diff/leaderboard), stop firing the remaining cases, and force-free the runtime of the in-flight ones (managed backends killed; self-hosted lease jobs aborted on the runner's next heartbeat). Already-terminal → conflict; other workspace / missing → NOT_FOUND.",
        inputSchema: { id: z.string().describe("scorecard id to stop (must be queued/running)") },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () => {
          await assertBatchReachable(ctx, "scorecards:run", id);
          return ok(serveScorecard(await scorecards.cancel({ tenant: ws, id })));
        }),
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
        annotations: { readOnlyHint: true },
        description:
          "This workspace's scorecards (summary only — excludes heavy per-case results). Each row carries the " +
          "served `headlinePassRate` (authority-ranked) — read it instead of re-deriving a representative from " +
          "summary order. Narrow by dataset or harness to see what a capability has been evaluated on over time " +
          "— that is the comparison to make before claiming something regressed.",
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
        annotations: { readOnlyHint: false },
        description:
          "Re-score a scorecard's retryable-unmeasured judge scores in place (transient judge LLM/transport blips) — no case re-execution; judge versions come from the batch's own pins. Non-judge unmeasured scores need a case re-run (retry) and come back as `skipped`. Returns {id, rescoredJudges, skipped}.",
        inputSchema: { id: z.string().describe("the scorecard id whose retryable-unmeasured judge scores to recover") },
      },
      ({ id }) =>
        run(principal, "scorecards:run", async () => {
          await assertBatchReachable(ctx, "scorecards:run", id);
          return ok(await scorecards.rescoreUnmeasured({ tenant: ws, id, submittedBy: principal.subject }));
        }),
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
        annotations: { readOnlyHint: true },
        description:
          "A full scorecard (including per-case results). Served enrichments: `headlinePassRate` (authority-ranked), `casePass` {pass,total} (verdicted denominator — never divide by executed), `outcomes` (requested/executed/gradeable/verdicted + infraFailed/cancelled/unmeasured — an infra failure is recovery work, never a product FAIL), per-case `verdict`+`verdictBasis` (which rung decided) and `evidenceStatus`, `retryableUnmeasured` (rescore worklist size), `verdictPolicy` stamp + `manifest` digests, and `caseRuns` — the receipt-canonical (case, trial) → child run map, the ONLY correct way to open a case's execution detail (a retried case has several children; only the receipted one is this batch's evidence). `policyResolution` says whether that stamp could be RESTORED: 'unresolvable' means the stamped policy document is gone, so `verdict`/`casePass`/`outcomes` are ABSENT rather than re-derived under today's ladder — read the absence, never treat it as 0. Other workspaces get NOT_FOUND",
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
          // BFF parity — the agent gets the same receipt-canonical case→run map the screen does.
          return ok(serveScorecard(record, await scorecards.canonicalCaseRuns(record.id)));
        }),
    );

    server.registerTool(
      "diff_scorecards",
      {
        annotations: { readOnlyHint: true },
        description:
          "Compare two scorecards (baseline vs candidate). Read `comparability` FIRST: 'none' means the comparison does not hold (no shared cases/metrics, `policyMismatch` — different verdict policies — or `policyUnresolvable` — a side whose stamped policy could not be restored, so its verdicts cannot be re-derived at all) — a different claim from 'no differences'. `missing` enumerates one-sided cases/metrics (never zero-filled), `incomparable` lists kind-changed metrics, and each metric delta carries `direction`+`reading` — never interpret a delta's sign alone. Then: per-case pass transitions → regressions/improvements. When either ran trials, a statistically-gated 'trials' diff (Fisher-exact small-n, minDelta practical floor) rides along.",
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
      "gate_scorecards",
      {
        annotations: { readOnlyHint: false },
        description:
          "Release-gate a candidate scorecard against a baseline → {decision: pass|block|blocked_missing|not_comparable, reasons, evidence}. TWO decisions are neither pass nor a regression block, and neither may be read as a green light: `not_comparable` (policy mismatch / zero shared cases — the comparison does not hold) and `blocked_missing` (the comparison held, but not over enough — cases the candidate never ran, metrics that vanished or changed kind, or scores that were not measurements). The gate is FAIL-CLOSED: a partial comparison blocks unless you pass comparability=allow_partial and state your tolerance. With trials, the Fisher-gated trials diff is the authoritative regression signal (z_threshold/min_delta set its bar). The decision embeds its effective policy (+digest) and is RECORDED on the candidate for the gate audit. HTTP parity (POST /scorecards/gate).",
        inputSchema: {
          baseline: z.string(),
          candidate: z.string(),
          max_regressions: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("regressions tolerated before block (default 0 — any regression blocks)"),
          comparability: z
            .enum(["require_full", "allow_partial"])
            .optional()
            .describe(
              "what an INCOMPLETE comparison means (default require_full — a partial comparison is blocked_missing, because 0 regressions over the cases that survived is evidence about those cases only)",
            ),
          max_missing_cases: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("allow_partial only: one-sided cases (both directions) tolerated"),
          max_missing_fraction: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("allow_partial only: share of the BASELINE's cases the candidate may skip"),
          max_unmeasured_fraction: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "share of compared scores that may be non-measurements (dead graders / skipped judges); enforced under either comparability mode",
            ),
          max_metric_loss_fraction: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "allow_partial only: share of a metric's BASELINE measurement rate the candidate may lose before the gate blocks (rows a grader silently never emitted; 100/100 → 1/100 is a 0.99 loss, complete disappearance is 1.0). require_full blocks any loss",
            ),
          allow_metric_kind_change: z
            .boolean()
            .optional()
            .describe(
              "allow_partial only: accept metrics whose VALUE KIND changed between the sides (same name, different meaning — the delta is unreadable). Unset = a kind change blocks even under allow_partial",
            ),
          allow_confounds: z
            .array(z.enum(["dataset_content", "grading_plan", "judge_set", "harness_model"]))
            .optional()
            .describe(
              "experiment-identity axes accepted as DIFFERENT (recorded on the decision): the manifests seal the dataset content, grading plan and judge documents each batch actually evaluated, and a verified difference on an axis not listed here refuses the pair as not_comparable — a different experiment, not a treatment comparison",
            ),
          allow_unverified_identity: z
            .boolean()
            .optional()
            .describe(
              "accept UNVERIFIABLE experiment identity explicitly (an unsealed pre-manifest side, a digest-era gap, a pre-split composite seal): by default the gate refuses to issue green on an identity nobody can verify — analytics may say 'unknown', a release gate may not say 'green'. Recorded on the decision",
            ),
          z_threshold: z
            .number()
            .positive()
            .optional()
            .describe("confidence threshold for the trial regression gate (default 1.96 ≈ 95%; trials only)"),
          min_delta: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("practical-significance floor for a trial pass-rate drop (default 0; trials only)"),
          fdr_alpha: z
            .number()
            .gt(0)
            .lt(1)
            .optional()
            .describe(
              "Benjamini-Hochberg false-discovery level across the per-case trial tests (e.g. 0.05; trials only). Every case is its own hypothesis test, so 200 cases at alpha 0.05 manufacture ~10 false regressions and under max_regressions 0 any one of them blocks the release. Unset = no correction (each case gated at its own alpha)",
            ),
        },
      },
      ({
        baseline,
        candidate,
        max_regressions,
        comparability,
        max_missing_cases,
        max_missing_fraction,
        max_unmeasured_fraction,
        max_metric_loss_fraction,
        allow_metric_kind_change,
        allow_confounds,
        allow_unverified_identity,
        z_threshold,
        min_delta,
        fdr_alpha,
      }) =>
        run(principal, "scorecards:run", async () =>
          ok(
            await scorecards.gate({
              tenant: ws,
              baseline,
              candidate,
              policy: {
                ...(max_regressions !== undefined ? { maxRegressions: max_regressions } : {}),
                ...(comparability !== undefined ? { comparability } : {}),
                ...(max_missing_cases !== undefined ? { maxMissingCases: max_missing_cases } : {}),
                ...(max_missing_fraction !== undefined ? { maxMissingFraction: max_missing_fraction } : {}),
                ...(max_unmeasured_fraction !== undefined ? { maxUnmeasuredFraction: max_unmeasured_fraction } : {}),
                ...(max_metric_loss_fraction !== undefined ? { maxMetricLossFraction: max_metric_loss_fraction } : {}),
                ...(allow_metric_kind_change !== undefined ? { allowMetricKindChange: allow_metric_kind_change } : {}),
                ...(allow_confounds !== undefined ? { allowConfounds: allow_confounds } : {}),
                ...(allow_unverified_identity !== undefined
                  ? { allowUnverifiedIdentity: allow_unverified_identity }
                  : {}),
                ...(z_threshold !== undefined ? { zThreshold: z_threshold } : {}),
                ...(min_delta !== undefined ? { minDelta: min_delta } : {}),
                ...(fdr_alpha !== undefined ? { fdrAlpha: fdr_alpha } : {}),
              },
              decidedBy: principal.subject,
              ...(await teamCeiling(ctx.deps, principal)),
            }),
          ),
        ),
    );

    server.registerTool(
      "override_scorecard_gate",
      {
        annotations: { readOnlyHint: false },
        description:
          "Force a BLOCKING gate decision through — recorded, never silent: who and why land on the decision and the gate audit counts it. Only a blocking decision can be overridden — `block` and `blocked_missing` alike (409 otherwise: pass needs no force, not_comparable has nothing to force). HTTP parity (POST /scorecards/:id/gate/override).",
        inputSchema: {
          candidate: z.string().describe("the candidate scorecard id the decision was recorded on"),
          decision_id: z.string(),
          reason: z.string().min(1).describe("why this ships anyway — required, it is the audit trail"),
        },
      },
      ({ candidate, decision_id, reason }) =>
        run(principal, "scorecards:run", async () => {
          await assertBatchReachable(ctx, "scorecards:run", candidate);
          return ok(
            await scorecards.overrideGate({
              tenant: ws,
              candidate,
              decisionId: decision_id,
              reason,
              by: principal.subject,
            }),
          );
        }),
    );

    server.registerTool(
      "flake_scorecards",
      {
        annotations: { readOnlyHint: true },
        description:
          "Cross-batch flake index for a dataset: (case, harness@version, runtime) keys that produced BOTH pass and fail verdicts across succeeded batches — 'that test is just flaky' made refutable. Verdicts derive under each batch's OWN stamped policy; an unverdicted case (infra death) is no observation — an outage is not a flake. Advisory: nothing is auto-quarantined. HTTP parity (GET /scorecards/flake).",
        inputSchema: {
          dataset: z.string(),
          harness: z.string().optional().describe("restrict to one harness id"),
        },
      },
      ({ dataset, harness }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.flake(ws, {
              datasetId: dataset,
              ...(harness ? { harnessId: harness } : {}),
              ...(await teamCeiling(ctx.deps, principal)),
            }),
          ),
        ),
    );

    server.registerTool(
      "verify_scorecard_manifest",
      {
        annotations: { readOnlyHint: true },
        description:
          "Verify a scorecard's reproducibility manifest against the CURRENT registry state — per-subject digest checks (dataset/harness/judges/verdict policy): match | drifted | missing | unverifiable. Each check runs under the stamp's own algorithm: `sha256:` stamps are collision-resistant, pre-sha256 bare-hex FNV stamps are identity against honest data and never tamper-evidence (the caveat rides the response and says which). HTTP parity (POST /scorecards/:id/verify-manifest).",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        run(principal, "scorecards:read", async () => {
          await assertBatchReachable(ctx, "scorecards:read", id);
          return ok(await scorecards.verifyManifest(ws, id));
        }),
    );

    server.registerTool(
      "estimate_scorecard",
      {
        annotations: { readOnlyHint: true },
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
      "trend_scorecards",
      {
        annotations: { readOnlyHint: true },
        description:
          "Regression-over-time for one (dataset, metric): time-ordered points with score/deltaVsBaseline/regressed. Read `direction` (absent = unknown — never interpret a delta's sign alone) and `policyMixed`/per-point `policyDiffers` FIRST: cross-policy points never flag regressed. metric absent = the server resolves the highest-authority pass-rate metric present.",
        inputSchema: {
          dataset: z.string(),
          metric: z.string().optional(),
          harness: z.string().optional(),
          from: z.string().optional().describe("ISO lower bound (createdAt)"),
          to: z.string().optional().describe("ISO upper bound (createdAt)"),
          baseline: z.string().optional().describe("baseline scorecard id (default: the first point)"),
        },
      },
      ({ dataset, metric, harness, from, to, baseline }) =>
        run(principal, "scorecards:read", async () =>
          ok(
            await scorecards.trend(ws, {
              datasetId: dataset,
              ...(metric ? { metric } : {}), // absent = preferredMetric over the data (BFF parity)
              ...(harness ? { harnessId: harness } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
              ...(baseline ? { baseline } : {}),
              ...(await teamCeiling(ctx.deps, principal)),
            }),
          ),
        ),
    );

    server.registerTool(
      "leaderboard_scorecards",
      {
        annotations: { readOnlyHint: true },
        description:
          "(harness × model) ranking for one dataset (benchmark) — descending by metric. window=latest(default)|best. Optional harness/model/judge_model filters (judge_model = fair comparison among the same grader). `policyMixed` marks a ranking produced under different verdict policies — disclose it before comparing rows.",
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
        annotations: { readOnlyHint: true },
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
        annotations: { readOnlyHint: true },
        description:
          "Get a scorecard's offloaded analysis bundle (analysisRef) as one JSON document: aggregate summary + " +
          "per-case verdicts/scores/failures — the case-level deep dive without reading every child run. Pass " +
          "revision to get that scoring revision's FROZEN artifact (immutable history) instead of the current " +
          "bundle. 404 when the record has no downloadable analysis artifact (or the revision has no frozen one).",
        inputSchema: {
          id: z.string().describe("Scorecard id"),
          revision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Scoring revision whose frozen analysis artifact to return (default: the current bundle)"),
        },
      },
      ({ id, revision }) =>
        run(principal, "scorecards:read", async () =>
          ok(await scorecards.analysisBundle(ws, id, await visibleTeamsFor(ctx.deps, principal), revision)),
        ),
    );

    server.registerTool(
      "backfill_scorecard_models",
      {
        annotations: { readOnlyHint: false },
        description:
          "Backfill the observed model from stored traces into past succeeded scorecards that lack models (idempotent). Use to include past runs on the leaderboard.",
        inputSchema: {},
      },
      () => run(principal, "scorecards:run", async () => ok(await scorecards.backfillModels(ws))),
    );

    server.registerTool(
      "ingest_scorecard",
      {
        annotations: { readOnlyHint: false },
        description:
          "Upload externally produced traces (TraceEvent[]) into a scorecard (harness not run). dataset/harness are OPTIONAL labels — omit both to evaluate the uploaded traces directly (each trace = one case, judges only). body=IngestScorecard JSON {dataset?,harness?,traces:[{caseId,trace}],judges?}",
        inputSchema: { body: z.string().describe("IngestScorecard JSON") },
      },
      ({ body }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return fail("BAD_REQUEST: not a valid IngestScorecard JSON.");
        }
        // Owner resolved AND GATED like the HTTP twin (teamForNew + gate(owner.gate)) — resolving the team
        // without authorizing against it let an agent file an ingested batch under a team its member is not
        // on, a request the route 403s. runForTeam is the one helper both transports' semantics live in.
        return runForTeam(ctx, "scorecards:run", teamIdIn(parsed), async (owner) => {
          const result = IngestScorecardBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(
            await scorecards.ingest({
              tenant: ws,
              submittedBy: principal.subject,
              ...(owner !== undefined ? { teamId: owner } : {}),
              ...result.data,
              // Same trigger provenance the route stamps — without it, MCP-ingested batches fall out of the
              // originSource filter dimension.
              origin: { source: originSource(principal.via) },
            }),
          );
        });
      },
    );

    server.registerTool(
      "pull_scorecard",
      {
        annotations: { readOnlyHint: false },
        description:
          "Pull per-runId traces from the tenant's observability platform (otel|mlflow|langfuse|langsmith|phoenix) into a scorecard (harness not run). dataset/harness are OPTIONAL labels — omit both to evaluate the pulled traces directly (each trace = one case, judges only). source is EITHER a registered workspace source by name {name} (register once in Settings › Observability, then pull by name) OR an inline config {kind,endpoint,authSecret?,project?[required for phoenix]}. body=PullIngest JSON {dataset?,harness?,source,runs:[{caseId,runId}],judges?}",
        inputSchema: { body: z.string().describe("PullIngest JSON") },
      },
      ({ body }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return fail("BAD_REQUEST: not a valid PullIngest JSON.");
        }
        // Same gate as the HTTP twin — the named team is authorized against, never just resolved.
        return runForTeam(ctx, "scorecards:run", teamIdIn(parsed), async (owner) => {
          const result = PullIngestBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(
            await scorecards.ingestPull({
              tenant: ws,
              submittedBy: principal.subject,
              ...(owner !== undefined ? { teamId: owner } : {}),
              ...result.data,
              origin: { source: originSource(principal.via) },
            }),
          );
        });
      },
    );
  }
}
