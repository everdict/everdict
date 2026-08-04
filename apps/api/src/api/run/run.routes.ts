import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { teamCeiling } from "../../common/team-scope.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, teamForNew } from "../route-context.js";
import { SubmitBodySchema } from "./request/submit.js";
import { runDocs } from "./run.docs.js";

// runs — the async execution primitive: submit returns a run id; the result arrives by poll or webhook.
export function registerRunRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/runs", { schema: runDocs.submit }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    let body: z.infer<typeof SubmitBodySchema>;
    try {
      body = SubmitBodySchema.parse(req.body);
    } catch (err) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message });
    }
    // 결과의 소유 팀 — 스코어카드와 같은 규칙.
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      // 팀 ref 해석(id 또는 key)이 여기서 일어난다 — 없는 팀은 404 이고, 그 답도 게이트와 같은 자리에서 나가야 한다.
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "runs:submit", owner.gate);
      // submittedBy=subject → clone a private-repo seed with the submitter's personal connection ("clone with my connection").
      return reply.code(202).send(
        await deps.service.submit({
          tenant: principal.workspace,
          submittedBy: principal.subject,
          ...(owner.teamId !== undefined ? { teamId: owner.teamId } : {}),
          ...body,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/runs/:id", { schema: runDocs.get }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      // getForDisplay, not get: this answer is rendered, so its artifact refs must be browser-openable (the stored
      // ones point at the in-network object store and have expired). The MCP get_run twin does the same.
      // The viewer decides what is readable: another member's agent turn / shell session answers 404, the
      // same as another workspace's run (`runAudience` — no existence leak either way).
      const record = await deps.service.getForDisplay(req.params.id, principal.subject);
      if (!record || record.tenant !== principal.workspace)
        return reply.code(404).send({ code: "NOT_FOUND", message: "run not found." });
      return reply.send(record);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The OWNED trajectory (P5 dual-read): the sealed copy from the trajectory store, falling back to the
  // run row's embed in the same shape — consumers never care which copy served.
  app.get<{ Params: { id: string } }>("/runs/:id/trajectory", { schema: runDocs.trajectory }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const trajectory = await deps.service.trajectory(principal.workspace, req.params.id, principal.subject);
      if (!trajectory) return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory not found." });
      return reply.send(trajectory);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{
    Querystring: { scorecardId?: string; scope?: string; runner?: string; limit?: string; offset?: string };
  }>("/runs", { schema: runDocs.list }, async (req, reply) => {
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      // scorecardId → that batch's child runs (case drill-down); scope=all → standalone + scorecard children
      // (activity console's "all executions", grouped in the UI); runner → runs a self-hosted runner executed
      // (runner-detail activity feed, offset-paginated by limit); otherwise the standalone activity list.
      const { scorecardId, scope, runner, limit, offset } = req.query;
      const parsedLimit = limit !== undefined && /^\d+$/.test(limit) ? Number(limit) : undefined;
      const parsedOffset = offset !== undefined && /^\d+$/.test(offset) ? Number(offset) : undefined;
      const opts = scorecardId
        ? { scorecardId }
        : runner
          ? {
              runnerId: runner,
              ...(parsedLimit ? { limit: parsedLimit } : {}),
              ...(parsedOffset ? { offset: parsedOffset } : {}),
            }
          : scope === "all"
            ? { includeChildren: true }
            : undefined;
      return reply.send(
        await deps.service.list(principal.workspace, {
          ...opts,
          viewer: principal.subject,
          // Second ceiling, orthogonal to the audience one above: a private team's runs are that team's work.
          ...(await teamCeiling(deps, principal)),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
