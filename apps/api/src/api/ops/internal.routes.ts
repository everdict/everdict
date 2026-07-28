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
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    const { tenant, source, model, inputTokens, outputTokens } = body.data;
    const cost = { usd: priceUsd(model, { inputTokens, outputTokens }), tokens: inputTokens + outputTokens };
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
        workspace: z.string().min(1),
        after: z.coerce.number().int().nonnegative().optional(),
        kinds: z.string().optional(), // comma-separated kind filter
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ code: "BAD_REQUEST", message: query.error.message });
    const { workspace, after, kinds, limit } = query.data;
    const events = await deps.platformEvents.list(workspace, {
      ...(after !== undefined ? { afterSeq: after } : {}),
      ...(kinds !== undefined ? { kinds: kinds.split(",").filter((k) => k.length > 0) } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send({ events });
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
