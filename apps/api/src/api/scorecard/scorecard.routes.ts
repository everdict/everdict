import { IngestScorecardBodySchema, PullIngestBodySchema, originSource } from "@everdict/application-control";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { teamCeiling, visibleTeamsFor } from "../../common/team-scope.js";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import {
  type ServerDeps,
  gate,
  resolvePrincipal,
  resolveTeamRef,
  sendError,
  teamForNew,
  zodIssues,
} from "../route-context.js";
import { MoveToTeamBodySchema } from "../team-move.js";
import { AnalysisQueryBodySchema } from "./request/analysis-query.js";
import { RerunScorecardBodySchema } from "./request/rerun-scorecard.js";
import { RunScorecardBodySchema } from "./request/run-scorecard.js";
import { scorecardDocs } from "./scorecard.docs.js";
import { serveScorecard, serveScorecardListItem } from "./serve.js";

// scorecards (dataset×harness batch eval → aggregated result): run/retry, push+pull trace ingest,
// list/get, estimate, baseline↔candidate diff, leaderboard/trend, flexible analysis pivot (query) +
// offloaded analysis bundle, model backfill.
export function registerScorecardRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/scorecards", { schema: scorecardDocs.submit }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    // 이 배치를 소유할 팀 — 자산과 같은 축이라 "우리 팀이 무엇을 평가했나"가 답 가능해진다. 명시 지정만
    // 인가 대상이고(남의 팀 앞으로 돌리는 것은 거절), 지정이 없으면 내 팀 → 워크스페이스 기본 팀 순이다.
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      // 팀 ref 해석(id 또는 key)이 여기서 일어난다 — 없는 팀은 404 이고, 그 답도 게이트와 같은 자리에서 나가야 한다.
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "scorecards:run", owner.gate);
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof RunScorecardBodySchema>;
    try {
      body = RunScorecardBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      // Dataset not found → NotFoundError → 404. On pass, 202 + a queued record (the batch runs in the background).
      // submittedBy=subject → clone private-repo cases with the submitter's personal connection.
      // origin.source is decided server-side (via mapping) — only the client coordinates (repo/sha/…) come from the body.
      return reply.code(202).send(
        await deps.scorecardService.submit({
          tenant: principal.workspace,
          submittedBy: principal.subject,
          // Only what the caller actually NAMED is an owner claim (owner.gate carries exactly that); the rest is
          // the fallback the service reaches for after the harness's own team. Passing owner.teamId as `teamId`
          // would make "whichever membership loaded first" outrank what was run.
          ...(owner.gate.teamId !== undefined ? { teamId: owner.gate.teamId } : {}),
          ...(owner.teamId !== undefined ? { submitterTeamId: owner.teamId } : {}),
          ...body,
          origin: { source: originSource(principal.via), ...(body.origin ?? {}) },
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Retry-failed — a NEW scorecard that re-runs only the failed cases of a terminal batch; passing results are
  // carried over verbatim and origin.retryOf keeps the lineage (the source record is never mutated).
  // Same gate as submit (scorecards:run). docs/architecture/batch-resilience.md
  app.post<{ Params: { id: string } }>("/scorecards/:id/retry", { schema: scorecardDocs.retry }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
      // Optional failure-class filter (?class=infra) — re-run only that class's casualties (agent FAILs stay carried).
      const cls = (req.query as { class?: string } | undefined)?.class;
      if (cls !== undefined && !["infra", "config", "harness", "agent"].includes(cls))
        return reply.code(400).send({ code: "BAD_REQUEST", message: "class must be infra|config|harness|agent." });
      return reply.code(202).send(
        await deps.scorecardService.retryFailed({
          tenant: principal.workspace,
          id: req.params.id,
          submittedBy: principal.subject,
          ...(cls ? { failureClass: cls as "infra" | "config" | "harness" | "agent" } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not found 404 / not terminal · nothing failed 400
    }
  });

  // Full re-run — a NEW scorecard that re-runs a terminal batch's ENTIRE case set (전체 재실행), reproducing the
  // original submit config and optionally overriding the run-config knobs from the body: WHO runs it (judges/runtime)
  // and HOW it is dispatched (concurrency/retries/subset). Scoring is reproduced verbatim (never overridden). Distinct
  // from /retry (which recovers only the failed cases and carries the passing ones over). Same gate as submit
  // (scorecards:run). docs/architecture/batch-resilience.md
  app.post<{ Params: { id: string } }>("/scorecards/:id/rerun", { schema: scorecardDocs.rerun }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
    } catch (err) {
      return sendError(reply, err);
    }
    let body: z.infer<typeof RerunScorecardBodySchema>;
    try {
      body = RerunScorecardBodySchema.parse(req.body ?? {});
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    try {
      return reply.code(202).send(
        await deps.scorecardService.rerun({
          tenant: principal.workspace,
          id: req.params.id,
          submittedBy: principal.subject,
          ...body,
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not found 404 / not terminal 400
    }
  });

  // Stop a running (or queued) batch — a user-initiated cancel. Marks it `cancelled` (terminal, not counted in
  // baseline/diff/leaderboard), stops firing the remaining cases, and force-frees the runtime of the in-flight ones
  // (managed backends via kill, self-hosted lease jobs via the runner's next heartbeat). Same gate as submit.
  // Already-terminal → 409; another workspace's / a missing scorecard → 404 (no existence leak).
  app.post<{ Params: { id: string } }>(
    "/scorecards/:id/cancel",
    { schema: scorecardDocs.cancel },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:run");
        const record = await deps.scorecardService.cancel({ tenant: principal.workspace, id: req.params.id });
        return reply.send(serveScorecard(record));
      } catch (err) {
        return sendError(reply, err); // not found 404 / already terminal 409
      }
    },
  );

  // Hard-delete a terminal scorecard and its fan-out child runs — the batch's creator or a workspace admin
  // (scorecards:delete), enforced in the service (creator exception never lives in the route). An in-flight batch
  // is a 409 (stop it first); another workspace's / a missing scorecard is a 404 (no existence leak).
  app.delete<{ Params: { id: string } }>("/scorecards/:id", { schema: scorecardDocs.remove }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      return reply.send(await deps.scorecardService.delete({ principal, id: req.params.id }));
    } catch (err) {
      return sendError(reply, err); // no permission 403 / not found 404 / still running 409
    }
  });

  // Re-file a batch under another team. A scorecard is the EVIDENCE a capability produced and is read through
  // the same team lens the capability is, so it moves the same way — otherwise handing a harness to another team
  // strands every result it ever produced. Both teams are authorized in the service.
  app.post<{ Params: { id: string } }>("/scorecards/:id/team", { schema: scorecardDocs.move }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = MoveToTeamBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await deps.scorecardService.moveToTeam({
          principal,
          id: req.params.id,
          // Resolved here (id or key, `ENG`) so an unknown team is a 404 rather than a puzzling 403.
          teamId: await resolveTeamRef(deps, principal.workspace, body.data.teamId),
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not on one of the teams 403 / unknown scorecard 404 / already there 409
    }
  });

  // Trace ingest — upload traces already produced externally (TraceEvent[]) and turn them into a scorecard (no harness run). Validated at the boundary.
  app.post("/scorecards/ingest", { schema: scorecardDocs.ingest }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    // Same owner resolution a live run gets — an ingested batch is a result, and a result belongs to a team.
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "scorecards:run", owner.gate);
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = IngestScorecardBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.code(202).send(
        await deps.scorecardService.ingest({
          tenant: principal.workspace,
          submittedBy: principal.subject, // executor label/filter (createdBy)
          ...(owner.teamId !== undefined ? { teamId: owner.teamId } : {}),
          ...parsed.data,
          origin: { source: originSource(principal.via) },
        }),
      );
    } catch (err) {
      return sendError(reply, err); // dataset not found → 404
    }
  });

  // Pull ingest — pull per-runId traces from the tenant's OTel/MLflow and score them (no harness run). Source credentials are authSecret (SecretStore).
  app.post("/scorecards/ingest/pull", { schema: scorecardDocs.ingestPull }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    // Same owner resolution a live run gets — an ingested batch is a result, and a result belongs to a team.
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "scorecards:run", owner.gate);
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = PullIngestBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.code(202).send(
        await deps.scorecardService.ingestPull({
          tenant: principal.workspace,
          submittedBy: principal.subject, // executor label/filter (createdBy)
          ...(owner.teamId !== undefined ? { teamId: owner.teamId } : {}),
          ...parsed.data,
          origin: { source: originSource(principal.via) },
        }),
      );
    } catch (err) {
      return sendError(reply, err); // dataset not found → 404
    }
  });

  app.get<{ Querystring: { judge?: string; schedule?: string; dataset?: string; harness?: string; team?: string } }>(
    "/scorecards",
    { schema: scorecardDocs.list },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        const { judge, schedule, dataset, harness, team } = req.query;
        // Mutually-exclusive detail-history narrows: ?schedule= (schedule's run history) | ?judge= (judge's eval history).
        // ?dataset=/?harness= are the combinable capability narrows (the store has always supported them) — they
        // answer "what has this capability been evaluated on", which the tracker's issue history is built from and
        // the web previously reconstructed by grouping the whole workspace list client-side.
        const narrow = schedule
          ? { scheduleId: schedule }
          : judge
            ? { judge }
            : dataset !== undefined || harness !== undefined
              ? { ...(dataset !== undefined ? { dataset } : {}), ...(harness !== undefined ? { harness } : {}) }
              : undefined;
        // ?team= COMBINES with the narrows above rather than replacing them — it answers "of these, which are
        // ours", which is the question the team sidebar asks. Named by id or by key (`?team=ENG`), the same ref
        // the team-scoped URL carries. It is a NARROW, and `visibleTeams` below is the separate CEILING: naming a
        // team you are not on returns nothing rather than that team's work.
        const teamId = team === undefined ? undefined : await resolveTeamRef(deps, principal.workspace, team);
        const filter = {
          ...(narrow ?? {}),
          ...(teamId !== undefined ? { teamId } : {}),
          ...(await teamCeiling(deps, principal)),
        };
        return reply.send((await deps.scorecardService.list(principal.workspace, filter)).map(serveScorecardListItem));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // baseline vs candidate comparison (regressions/improvements). Static path → matched before :id. Both must be this workspace's and completed.
  // Cost/time preflight — history-based estimate for a dataset×harness batch ("what will it cost / how long").
  // Honest empty when no history (basis.samples=0). Same gate as reading scorecards.
  app.get<{ Querystring: { dataset?: string; harness?: string; cases?: string; concurrency?: string } }>(
    "/scorecards/estimate",
    { schema: scorecardDocs.estimate },
    async (req, reply) => {
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        if (!deps.scorecardService)
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
        const { dataset, harness, cases, concurrency } = req.query;
        if (!dataset || !harness)
          return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset and harness are required." });
        return reply.send(
          await deps.scorecardService.estimate({
            tenant: principal.workspace,
            dataset,
            harness,
            ...(cases !== undefined ? { cases: Number(cases) } : {}),
            ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Querystring: { baseline?: string; candidate?: string; z?: string } }>(
    "/scorecards/diff",
    { schema: scorecardDocs.diff },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { baseline, candidate, z } = req.query;
      if (!baseline || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "baseline and candidate query parameters are required." });
      // Optional confidence for the trial regression gate (default 1.96 ≈ 95%). Only used when either side has trials.
      let zThreshold: number | undefined;
      if (z !== undefined) {
        zThreshold = Number(z);
        if (!Number.isFinite(zThreshold) || zThreshold <= 0)
          return reply.code(400).send({ code: "BAD_REQUEST", message: "z must be a positive number." });
      }
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await deps.scorecardService.diff(principal.workspace, baseline, candidate, {
            ...(zThreshold !== undefined ? { zThreshold } : {}),
            ...(await teamCeiling(deps, principal)),
          }),
        );
      } catch (err) {
        return sendError(reply, err); // 404 if not found, 400 if incomplete
      }
    },
  );

  // Period trend / regression-over-time — one (dataset, metric)'s scorecards in time order + regression vs baseline. Static path → before :id.
  app.get<{
    Querystring: { dataset?: string; metric?: string; harness?: string; from?: string; to?: string; baseline?: string };
  }>("/scorecards/trend", { schema: scorecardDocs.trend }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { dataset, metric, harness, from, to, baseline } = req.query;
    if (!dataset) return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset query parameter is required." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(
        await deps.scorecardService.trend(principal.workspace, {
          datasetId: dataset,
          // absent = server resolves the highest-authority pass-rate metric present (preferredMetric) —
          // a literal default gave workspaces with differently-named graders a silently empty view.
          ...(metric ? { metric } : {}),
          ...(harness ? { harnessId: harness } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(baseline ? { baseline } : {}),
          ...(await teamCeiling(deps, principal)),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-benchmark leaderboard — (harness × model) ranking over one (dataset) (metric descending). Static path → before :id.
  app.get<{
    Querystring: {
      dataset?: string;
      metric?: string;
      harness?: string;
      model?: string;
      judgeModel?: string;
      window?: string;
    };
  }>("/scorecards/leaderboard", { schema: scorecardDocs.leaderboard }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { dataset, metric, harness, model, judgeModel, window } = req.query;
    if (!dataset) return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset query parameter is required." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(
        await deps.scorecardService.leaderboard(principal.workspace, {
          datasetId: dataset,
          // absent = server resolves the highest-authority pass-rate metric present (preferredMetric) —
          // a literal default gave workspaces with differently-named graders a silently empty view.
          ...(metric ? { metric } : {}),
          ...(harness ? { harnessId: harness } : {}),
          ...(model ? { model } : {}),
          ...(judgeModel ? { judgeModel } : {}),
          window: window === "best" ? "best" : "latest", // anything else/unset = latest
          ...(await teamCeiling(deps, principal)),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Flexible analysis pivot — filter/group/pivot/measure over the workspace's scorecards (the server-side twin of
  // the web analyze dashboard; docs/architecture/analysis-studio.md V1). Static path → before :id.
  app.post("/scorecards/query", { schema: scorecardDocs.query }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = AnalysisQueryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error) });
    try {
      return reply.send(
        await deps.scorecardService.analysis(principal.workspace, parsed.data, await visibleTeamsFor(deps, principal)),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // model-axis backfill — fill past succeeded scorecards that lack models from stored traces (idempotent). Static path → before :id.
  app.post("/scorecards/backfill-models", { schema: scorecardDocs.backfillModels }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
      return reply.send(await deps.scorecardService.backfillModels(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/scorecards/:id", { schema: scorecardDocs.get }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      // getForDisplay, not get: the case snapshots on this answer are rendered, so their artifact refs must be
      // browser-openable (the stored ones point at the in-network object store and have expired). Same in the MCP twin.
      const record = await deps.scorecardService.getForDisplay(req.params.id);
      // Another team's batch is answered exactly like another workspace's, and like one that never existed.
      if (
        !record ||
        record.tenant !== principal.workspace ||
        !ownedByVisibleTeam(record, await visibleTeamsFor(deps, principal))
      )
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
      return reply.send(serveScorecard(record));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The offloaded analysis bundle (analysisRef) fetched server-side — per-case verdicts/scores as one JSON document.
  app.get<{ Params: { id: string } }>(
    "/scorecards/:id/analysis",
    { schema: scorecardDocs.analysisBundle },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await deps.scorecardService.analysisBundle(
            principal.workspace,
            req.params.id,
            await visibleTeamsFor(deps, principal),
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
