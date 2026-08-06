import { TraceEventSchema, TraceSpanSchema } from "@everdict/contracts";
import { issueKey } from "@everdict/db";
import { priceUsd } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { constantTimeEq } from "../route-context.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { internalDocs } from "./internal.docs.js";

// internal control-plane surface (x-internal-token guard, fail-closed): scheduling dials, tenant-key issuance, Temporal schedule fire/finalize + batch bridge.
export function registerInternalRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- internal: key issuance (x-internal-token guard, fail-closed if unset) ---
  // Operator fairness dials — adjust per-tenant quota/weight without a restart (overrides layer over the env
  // defaults; a restart falls back to env). Same guard as every /internal/** route.
  app.put("/internal/scheduling", { schema: internalDocs.schedulingSet }, async (req, reply) => {
    if (!deps.internalToken || !deps.schedulingControl)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scheduling control not configured" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "x-internal-token required." });
    const body = z
      .object({
        quotas: z.record(z.number().int().positive().nullable()).optional(),
        weights: z.record(z.number().positive().nullable()).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    deps.schedulingControl.set(body.data);
    return reply.send(deps.schedulingControl.effective());
  });
  app.get("/internal/scheduling", { schema: internalDocs.schedulingGet }, async (req, reply) => {
    if (!deps.internalToken || !deps.schedulingControl)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scheduling control not configured" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "x-internal-token required." });
    return reply.send(deps.schedulingControl.effective());
  });

  app.post("/internal/tenant-keys", { schema: internalDocs.tenantKeys }, async (req, reply) => {
    if (!deps.internalToken || !deps.keyStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ workspace: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const apiKey = await issueKey(deps.keyStore, body.data.workspace);
    return reply.code(201).send({ workspace: body.data.workspace, apiKey }); // the plaintext is returned only once here
  });

  // --- internal: usage report (agent server → meter). The agent loop yields TOKENS per conversation; the control
  // plane prices them into USD and records + settles them against the workspace, so agent-conversation cost lands in
  // the SAME meter + enforcement budget as evals. Same x-internal-token guard. docs/architecture/usage-metering.md ---
  app.post("/internal/usage", { schema: internalDocs.usage }, async (req, reply) => {
    if (!deps.internalToken || !deps.usageMeter)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z
      .object({
        tenant: z.string().min(1),
        source: z.enum(["harness", "judge", "agent"]),
        model: z.string(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        // Prompt-cache subsets of inputTokens — priced at the cache rates (read 0.1x / write 1.25x on Anthropic)
        // instead of the full input price. Optional: an older agent build simply bills cache tokens at input rate.
        cacheReadTokens: z.number().int().nonnegative().optional(),
        cacheWriteTokens: z.number().int().nonnegative().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const { tenant, source, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = body.data;
    const cost = {
      usd: priceUsd(model, {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      }),
      tokens: inputTokens + outputTokens,
    };
    deps.usageMeter.record(tenant, source, model, cost, 0); // an agent turn is not a metered evaluation (0)
    deps.settleBudget?.(tenant, cost); // reflect it in the enforcement budget too (settle only — never blocks)
    return reply.send({ ok: true });
  });

  // --- internal: discussion-agent comment lifecycle (agent server → placeholder comment). The detached discussion
  // turn (@everdict in a thread) reports its progress here: activity token while running, awaiting_approval on a
  // HITL park, then the final markdown body on complete (or failed). The control plane stays the ONLY comment
  // mutator. Same x-internal-token guard. ---
  app.post("/internal/comment-activity", { schema: internalDocs.commentActivity }, async (req, reply) => {
    if (!deps.internalToken || !deps.commentService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z
      .object({
        tenant: z.string().min(1),
        commentId: z.string().min(1),
        status: z.enum(["running", "awaiting_approval", "complete", "failed"]).optional(),
        activity: z.string().nullable().optional(), // machine token ("thinking"|"writing"|"tool:<name>"); null clears
        body: z.string().optional(), // the final markdown answer (terminal patch)
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const { tenant, commentId, status, activity, body: answer } = body.data;
      await deps.commentService.applyProgress(tenant, commentId, {
        ...(status !== undefined ? { status } : {}),
        ...(activity !== undefined ? { activity } : {}),
        ...(answer !== undefined ? { body: answer } : {}),
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err); // unknown/non-agent comment 404
    }
  });

  // --- internal: platform-event reconcile cursor (agent service → event log). The agent service walks
  // `seq > after` per workspace at startup/interval so a missed best-effort push is recovered (at-least-once +
  // event-id dedup — docs/architecture/agent-automation.md). Same x-internal-token guard. ---
  app.get("/internal/events", { schema: internalDocs.events }, async (req, reply) => {
    if (!deps.internalToken || !deps.platformEvents)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const query = z
      .object({
        // Omitted → the deployment-wide cursor (the agent service's ONE reconcile loop walks all workspaces).
        workspace: z.string().min(1).optional(),
        after: z.coerce.number().int().nonnegative().optional(),
        kinds: z.string().optional(), // comma-separated kind filter
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { workspace, after, kinds, limit } = query.data;
    const opts = {
      ...(after !== undefined ? { afterSeq: after } : {}),
      ...(kinds !== undefined ? { kinds: kinds.split(",").filter((k) => k.length > 0) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const events =
      workspace !== undefined
        ? await deps.platformEvents.list(workspace, opts)
        : await deps.platformEvents.listAll(opts);
    return reply.send({ events });
  });

  // --- internal: agent-run lifecycle facts (agent service → event log). The activation wrapper reports
  // agent.run.started/completed/failed/cancelled so the fleet view + audit read one durable record. These kinds
  // are NEVER trigger-matchable (agents watching agents is a runaway vector). Same x-internal-token guard. ---
  app.post("/internal/agent-run-events", { schema: internalDocs.agentRunEvents }, async (req, reply) => {
    if (!deps.internalToken || !deps.platformEvents)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z
      .object({
        tenant: z.string().min(1),
        kind: z.enum([
          "agent.run.started",
          "agent.run.awaiting_approval",
          "agent.run.completed",
          "agent.run.failed",
          "agent.run.cancelled",
        ]),
        sessionId: z.string().min(1),
        agentId: z.string().min(1),
        eventKind: z.string().min(1),
        message: z.string().min(1),
        // P3 ledger correlation (optional — an older agent service just keeps the event-only behavior):
        // the agent service mints one run id per activation/turn and threads it through every report.
        runId: z.string().min(1).optional(),
        // What opened this run (O1): an activation woken by a platform event (default) or a chat turn a
        // member typed. A chat turn takes the member-caused, interactive record — and stays OFF the event
        // log: agent.run.* exists so headless work is visible, while a conversation is already visible as
        // itself, and human typing volume would drown the log. (Same deliberate narrowing as ingest
        // completions — widening it is an E2 decision, not a default.)
        cause: z.enum(["event", "chat"]).default("event"),
        // The parked tool behind an awaiting_approval report (N8) — what the approval notification names.
        // Absent on an awaiting report = a plan review; ignored for every other kind.
        tool: z.string().min(1).optional(),
        agentVersion: z.string().min(1).optional(),
        eventId: z.string().min(1).optional(),
        creator: z.string().min(1).optional(),
        budgetUsd: z.number().positive().optional(),
        // O2 (transcripts are traces): a terminal report may carry the turn's transcript projected as
        // TraceEvent[] — sealed as the run's own trajectory (source "run", first write wins).
        trace: z.array(TraceEventSchema).optional(),
        // The turn's own spans when the agent recorded them live (N6) — preferred over `trace`.
        spans: z.array(TraceSpanSchema).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const {
      tenant,
      kind,
      sessionId,
      agentId,
      eventKind,
      message,
      runId,
      agentVersion,
      eventId,
      creator,
      budgetUsd,
      cause,
    } = body.data;
    if (cause !== "chat")
      await deps.platformEvents.emit({
        workspace: tenant,
        kind,
        subject: { type: "agent_session", id: sessionId },
        payload: { agentId, eventKind, ...(runId !== undefined ? { runId } : {}) },
        causedBy: `agent:${agentId}:${sessionId}`,
        message,
      });
    // HITL (N8): a park is a turn WAITING ON A HUMAN — the one lifecycle report that must come find its
    // person, because the surface it parked on (one of many conversations, a headless activation) is exactly
    // the one nobody is necessarily watching. One choke point for every lane that reports the park: an
    // activation reports it immediately (headless = unattended by definition), a chat turn only after the
    // agent-side grace found the ask still pending (an attended prompt is answered before the grace runs
    // out). Recipient = the run's creator — the member the turn works for. Best-effort like the ledger.
    if (kind === "agent.run.awaiting_approval" && creator !== undefined && deps.notificationService) {
      await deps.notificationService
        .notifyApprovalRequested(tenant, {
          recipient: creator,
          ...(body.data.tool !== undefined ? { tool: body.data.tool } : {}),
          place: { kind: "conversation", sessionId },
        })
        .catch(() => {});
    }
    // The universal ledger (execution-model P3, O4): started opens Run{kind:"agent"}, a terminal report
    // settles it. Both idempotent (at-least-once reporting); awaiting_approval is event-only.
    if (runId !== undefined) {
      if (kind === "agent.run.started") {
        if (cause === "chat") {
          // A chat turn's actor is not optional the way an activation's creator is — the member who typed it
          // IS the cause. No fallback: an unattributed turn would be a lie in the ledger.
          if (creator === undefined)
            return reply.code(400).send({ code: "BAD_REQUEST", message: "creator is required for cause=chat" });
          await deps.service.recordChatTurn({
            id: runId,
            tenant,
            agentId,
            ...(agentVersion !== undefined ? { agentVersion } : {}),
            sessionId,
            actor: creator,
          });
        } else
          await deps.service.recordAgentRun({
            id: runId,
            tenant,
            agentId,
            ...(agentVersion !== undefined ? { agentVersion } : {}),
            sessionId,
            eventKind,
            ...(eventId !== undefined ? { eventId } : {}),
            ...(creator !== undefined ? { createdBy: creator } : {}),
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          });
      } else if (kind !== "agent.run.awaiting_approval") {
        const outcome =
          kind === "agent.run.completed" ? "completed" : kind === "agent.run.cancelled" ? "cancelled" : "failed";
        await deps.service.settleAgentRun(runId, outcome, message, body.data.trace, body.data.spans);
      }
    }
    return reply.send({ ok: true });
  });

  // --- internal: activation admission (agent service → CP, §5.1 "reactions pass the gate") — the
  // activation itself is admitted against the tenant's enforcement budget BEFORE the run launches, exactly
  // like an eval dispatch (402 past the cap; a pass reserves one run, settled later via the usage bridge).
  app.post("/internal/activations/admit", { schema: internalDocs.admitActivation }, async (req, reply) => {
    if (!deps.internalToken || !deps.admitActivation)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      deps.admitActivation(body.data.tenant);
      return reply.send({ admitted: true });
    } catch (err) {
      return sendError(reply, err); // 402 BUDGET_EXCEEDED — the activator skips visibly
    }
  });

  // --- internal: schedule fire (called by the Temporal workflow, x-internal-token guard) ---
  // The worker doesn't hold a ScorecardService, so a schedule fire goes workflow→activity→this route→ScheduleService.fire.
  // tenant is baked in as a workflow argument at schedule creation and arrives in a trusted body (already trusted via the internal token).
  // --- Batch-on-Temporal internal bridge (worker activities → CP; the CP owns execution/scoring, the workflow
  // owns driver-loop durability). Same x-internal-token guard as the schedule bridge. ---
  app.post<{ Params: { id: string } }>(
    "/internal/batches/:id/plan",
    { schema: internalDocs.batchPlan },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      try {
        return reply.send(await deps.scorecardService.planBatch(req.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/internal/batches/:id/case",
    { schema: internalDocs.batchCase },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = z.object({ caseId: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.send(await deps.scorecardService.runBatchCase(req.params.id, body.data.caseId));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/internal/batches/:id/finalize",
    { schema: internalDocs.batchFinalize },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      try {
        await deps.scorecardService.finalizeBatch(req.params.id);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // --- Score-on-Temporal internal bridge (worker activities → CP; orchestration.md T-c `score:<groupId>`).
  // Same x-internal-token guard; the CP owns judging/aggregation, the workflow owns the pass's durability. ---
  const scoreJudges = z.object({
    judges: z.array(z.object({ id: z.string().min(1), version: z.string().min(1) })).min(1),
    submittedBy: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>(
    "/internal/groups/:id/score-plan",
    { schema: internalDocs.scorePlan },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = scoreJudges.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.send(await deps.scorecardService.planScore(req.params.id, body.data.judges));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/internal/groups/:id/score-case",
    { schema: internalDocs.scoreCase },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = scoreJudges.extend({ key: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.send(
          await deps.scorecardService.runScoreCase(
            req.params.id,
            body.data.key,
            body.data.judges,
            body.data.submittedBy,
          ),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/internal/groups/:id/score-finalize",
    { schema: internalDocs.scoreFinalize },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scorecardService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = scoreJudges.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        await deps.scorecardService.finalizeScore(req.params.id, body.data.judges, body.data.submittedBy);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/internal/schedules/:id/fire",
    { schema: internalDocs.scheduleFire },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scheduleService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        return reply.send(await deps.scheduleService.fire(body.data.tenant, req.params.id)); // { scorecardId }
      } catch (err) {
        return sendError(reply, err); // missing schedule 404, firer not configured 400
      }
    },
  );

  // Fire finalization — the workflow calls this after poll-to-terminal. Records the fired scorecard's terminal status on the schedule.
  app.post<{ Params: { id: string } }>(
    "/internal/schedules/:id/finalize",
    { schema: internalDocs.scheduleFinalize },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scheduleService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const body = z.object({ tenant: z.string().min(1), scorecardId: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
      try {
        await deps.scheduleService.finalize(body.data.tenant, req.params.id, body.data.scorecardId);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err); // missing schedule 404
      }
    },
  );

  // Status of the fired scorecard (workflow poll-to-terminal). Internal only.
  app.get<{ Params: { scorecardId: string } }>(
    "/internal/schedules/scorecard-status/:scorecardId",
    { schema: internalDocs.scorecardStatus },
    async (req, reply) => {
      if (!deps.internalToken || !deps.scheduleService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
      const provided = req.headers["x-internal-token"];
      if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
        return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
      const status = await deps.scheduleService.scorecardStatus(req.params.scorecardId);
      return reply.send({ status: status ?? null });
    },
  );
}
