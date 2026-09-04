import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  citableReport,
  originSource,
} from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {} from "../fs/fs-actor.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { AnalysisQueryBodySchema } from "./request/analysis-query.js";
import { GateScorecardsBodySchema, OverrideGateBodySchema } from "./request/gate-scorecards.js";
import {
  ScorecardCountsQuerySchema,
  ScorecardPageQuerySchema,
  scorecardFilterOf,
  scorecardPageOf,
} from "./request/list-scorecards.js";
import { RerunScorecardBodySchema } from "./request/rerun-scorecard.js";
import { RetryCasesBodySchema } from "./request/retry-cases.js";
import { RunScorecardBodySchema } from "./request/run-scorecard.js";
import { scorecardDocs } from "./scorecard.docs.js";
import { serveScorecard, serveScorecardListItem } from "./serve.js";

// scorecards (dataset×harness batch eval → aggregated result): run/retry, push+pull trace ingest,
// list/get, estimate, baseline↔candidate diff, leaderboard/trend, flexible analysis pivot (query) +
// offloaded analysis bundle, model backfill.
// ── IS THIS BATCH THIS WORKSPACE'S (arch-review 119) ───────────────────────────────────────────────
//
// Every OPERATIONAL door gated a bare `scorecards:run` and read nothing, so a caller in ANOTHER workspace —
// answered 404 for the same id on GET — could stop a running batch, RE-DRIVE it (a 202 and real compute spent
// on somebody else's evidence), rescore it, or override its gate decision. Reading was narrower than writing,
// which is the inversion tenancy exists to prevent.
//
// One resolver for all of them, so a door added later inherits the answer instead of re-deriving it. It
// answers 404 rather than 403 for the same reason the read does: another workspace's batch must not be
// discoverable by the shape of the error, and this id already reads as absent to this caller.
async function scorecardIsOurs(deps: ServerDeps, principal: Principal, id: string): Promise<boolean> {
  const record = await deps.scorecardService?.get(id);
  return record !== undefined && record.tenant === principal.workspace;
}

export function registerScorecardRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/scorecards", { schema: scorecardDocs.submit }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
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
          submitterRoles: principal.roles, // the constitution seed reads them (ground_truth declarations are admin-only)
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
      // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
      // the order `server.test.ts` pins by name ("gated before the service runs").
      gate(principal, "scorecards:run");
      // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an outsider
      // cannot operate on it (arch-review 119).
      if (!(await scorecardIsOurs(deps, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
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

  // Retry-cases — the same scorecard, a new attempt per named case, the displaced attempt preserved.
  // `POST /retry` above FORKS; this one repairs the record you have. Same gate as submit (scorecards:run).
  // docs/architecture/in-place-case-retry-spec.md
  app.post<{ Params: { id: string } }>(
    "/scorecards/:id/retry-cases",
    { schema: scorecardDocs.retryCases },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
        // the order `server.test.ts` pins by name ("gated before the service runs").
        gate(principal, "scorecards:run");
        // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an
        // outsider cannot operate on it (arch-review 119).
        if (!(await scorecardIsOurs(deps, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
        const body = RetryCasesBodySchema.parse(req.body);
        return reply.send(
          await deps.scorecardService.retryCases({
            tenant: principal.workspace,
            id: req.params.id,
            cases: body.cases,
            ...(body.reason ? { reason: body.reason } : {}),
            submittedBy: principal.subject,
          }),
        );
      } catch (err) {
        return sendError(reply, err); // 400 unsealed case / no reason · 404 missing · 409 running or claimed
      }
    },
  );

  // Targeted transient-scoring recovery: re-run ONLY the judges whose scores are retryable-unmeasured
  // (judge LLM/transport blips), replacing their rows in place — no case re-execution. Non-judge unmeasured
  // scores need a case re-run (/retry) and come back as `skipped`. Same gate as scoring (scorecards:run).
  app.post<{ Params: { id: string } }>(
    "/scorecards/:id/rescore-unmeasured",
    { schema: scorecardDocs.rescoreUnmeasured },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
        // the order `server.test.ts` pins by name ("gated before the service runs").
        gate(principal, "scorecards:run");
        // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an outsider
        // cannot operate on it (arch-review 119).
        if (!(await scorecardIsOurs(deps, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
        return reply.send(
          await deps.scorecardService.rescoreUnmeasured({
            tenant: principal.workspace,
            id: req.params.id,
            submittedBy: principal.subject,
          }),
        );
      } catch (err) {
        return sendError(reply, err); // not found 404 / no results yet 400
      }
    },
  );

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
      // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
      // the order `server.test.ts` pins by name ("gated before the service runs").
      gate(principal, "scorecards:run");
      // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an outsider
      // cannot operate on it (arch-review 119).
      if (!(await scorecardIsOurs(deps, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
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
        // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
        // the order `server.test.ts` pins by name ("gated before the service runs").
        gate(principal, "scorecards:run");
        // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an outsider
        // cannot operate on it (arch-review 119).
        if (!(await scorecardIsOurs(deps, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
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

  // Trace ingest — upload traces already produced externally (TraceEvent[]) and turn them into a scorecard (no harness run). Validated at the boundary.
  app.post("/scorecards/ingest", { schema: scorecardDocs.ingest }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:run");
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
    try {
      gate(principal, "scorecards:run");
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
          ...parsed.data,
          origin: { source: originSource(principal.via) },
        }),
      );
    } catch (err) {
      return sendError(reply, err); // dataset not found → 404
    }
  });

  app.get("/scorecards", { schema: scorecardDocs.list }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const query = ScorecardPageQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      gate(principal, "scorecards:read");
      // The page's bounds are OPTIONAL: without them this answers the whole collection, exactly as it always
      // did, so no existing caller changes behaviour. With them it answers the newest `limit` rows older than
      // the cursor — see the query schema for why the cursor is the last row rather than an opaque token.
      const filter = { ...scorecardFilterOf(query.data), ...scorecardPageOf(query.data) };
      return reply.send((await deps.scorecardService.list(principal.workspace, filter)).map(serveScorecardListItem));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // How many batches are in each bucket, under the SAME filter the list takes. A paged screen cannot get
  // these from its own rows — counting what it received only reports the page size back — so the headers of a
  // grouped list, and its total, come from here. Static path: declared before /scorecards/:id.
  app.get("/scorecards/counts", { schema: scorecardDocs.counts }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const query = ScorecardCountsQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    try {
      gate(principal, "scorecards:read");
      const groups = await deps.scorecardService.countByGroup(
        principal.workspace,
        query.data.groupBy,
        scorecardFilterOf(query.data),
      );
      return reply.send({
        groupBy: query.data.groupBy,
        groups,
        // Summed from the same groups rather than counted again: two statements answering one question is
        // how a total comes to disagree with the headers under it.
        total: groups.reduce((sum, group) => sum + group.count, 0),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

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

  // Release gate (A1) — the CI-facing decision, recorded on the candidate. Static path → before :id.
  app.post("/scorecards/gate", { schema: scorecardDocs.gate }, async (req, reply) => {
    if (!deps.scorecardService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = GateScorecardsBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      gate(principal, "scorecards:run");
      return reply.send(
        await deps.scorecardService.gate({
          tenant: principal.workspace,
          baseline: body.data.baseline,
          candidate: body.data.candidate,
          ...(body.data.policy ? { policy: body.data.policy } : {}),
          decidedBy: principal.subject,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // B1 — the recorded force: override a BLOCK, who and why on the ledger.
  app.post<{ Params: { id: string } }>(
    "/scorecards/:id/gate/override",
    { schema: scorecardDocs.gateOverride },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const body = OverrideGateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        // The ROLE first, before any store work: a viewer is 403 without this route reading anything —
        // the order `server.test.ts` pins by name ("gated before the service runs").
        gate(principal, "scorecards:run");
        // …then WHOSE batch it is. Refused as 404, the same answer the read gives for this id, so an outsider
        // cannot operate on it (arch-review 119).
        if (!(await scorecardIsOurs(deps, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
        return reply.send(
          await deps.scorecardService.overrideGate({
            tenant: principal.workspace,
            candidate: req.params.id,
            decisionId: body.data.decisionId,
            reason: body.data.reason,
            by: principal.subject,
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A2 — cross-batch flake index (static path → before :id).
  app.get<{ Querystring: { dataset?: string; harness?: string } }>(
    "/scorecards/flake",
    { schema: scorecardDocs.flake },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { dataset, harness } = req.query;
      if (!dataset)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset query parameter is required." });
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await deps.scorecardService.flake(principal.workspace, {
            datasetId: dataset,
            ...(harness ? { harnessId: harness } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // B3 — manifest verification: is the registry still exactly what this batch evaluated?
  app.post<{ Params: { id: string } }>(
    "/scorecards/:id/verify-manifest",
    { schema: scorecardDocs.verifyManifest },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        // The ROLE first, then WHOSE batch it is — the same pair every other operational door here carries,
        // and the MCP twin too (arch-review 119). Reading a manifest verification is reading the batch.
        gate(principal, "scorecards:read");
        if (!(await scorecardIsOurs(deps, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
        return reply.send(await deps.scorecardService.verifyManifest(principal.workspace, req.params.id));
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
      return reply.send(await deps.scorecardService.analysis(principal.workspace, parsed.data));
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
      // Another workspace's batch is answered exactly like one that never existed.
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard not found." });
      // Which child run is each (case, trial)'s answer — served, never re-derived by the client (the web used
      // to pair result rows with children positionally, which opens a retried case's SUPERSEDED attempt).
      return reply.send(serveScorecard(record, await deps.scorecardService.canonicalCaseRuns(record.id)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The offloaded analysis bundle (analysisRef) fetched server-side — per-case verdicts/scores as one JSON document.
  // ?revision=N serves that scoring revision's FROZEN artifact (immutable history) instead of the current bundle.
  // ── EXPORT WHAT IS CITABLE (docs/architecture/benchmark-evidence-spec.md §4) ─────────────────────────
  app.get<{ Params: { id: string }; Querystring: { allowProxy?: string } }>(
    "/scorecards/:id/report",
    { schema: scorecardDocs.report },
    async (req, reply) => {
      if (!deps.scorecardService || !deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard or dataset service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const allowProxy = req.query.allowProxy === "true";
      if (req.query.allowProxy !== undefined && req.query.allowProxy !== "true" && req.query.allowProxy !== "false")
        return reply.code(400).send({ code: "BAD_REQUEST", message: "allowProxy must be true or false." });
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await citableReport(
            { scorecards: deps.scorecardService, datasets: deps.datasetRegistry },
            principal.workspace,
            req.params.id,
            { allowProxy },
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>(
    "/scorecards/:id/analysis",
    { schema: scorecardDocs.analysisBundle },
    async (req, reply) => {
      if (!deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "scorecard service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const revisionParse = z.coerce.number().int().positive().optional().safeParse(req.query.revision);
      if (!revisionParse.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "revision must be a positive integer." });
      try {
        gate(principal, "scorecards:read");
        return reply.send(
          await deps.scorecardService.analysisBundle(principal.workspace, req.params.id, revisionParse.data),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
