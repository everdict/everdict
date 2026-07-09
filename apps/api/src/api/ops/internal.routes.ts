import { issueKey } from "@everdict/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { constantTimeEq } from "../route-context.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";

// internal control-plane surface (x-internal-token guard, fail-closed): scheduling dials, tenant-key issuance, Temporal schedule fire/finalize + batch bridge.
export function registerInternalRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // --- internal: key issuance (x-internal-token guard, fail-closed if unset) ---
  // Operator fairness dials — adjust per-tenant quota/weight without a restart (overrides layer over the env
  // defaults; a restart falls back to env). Same guard as every /internal/** route.
  app.put("/internal/scheduling", async (req, reply) => {
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
  app.get("/internal/scheduling", async (req, reply) => {
    if (!deps.internalToken || !deps.schedulingControl)
      return reply.code(404).send({ code: "NOT_FOUND", message: "scheduling control not configured" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "x-internal-token required." });
    return reply.send(deps.schedulingControl.effective());
  });

  app.post("/internal/tenant-keys", async (req, reply) => {
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

  // --- internal: schedule fire (called by the Temporal workflow, x-internal-token guard) ---
  // The worker doesn't hold a ScorecardService, so a schedule fire goes workflow→activity→this route→ScheduleService.fire.
  // tenant is baked in as a workflow argument at schedule creation and arrives in a trusted body (already trusted via the internal token).
  // --- Batch-on-Temporal internal bridge (worker activities → CP; the CP owns execution/scoring, the workflow
  // owns driver-loop durability). Same x-internal-token guard as the schedule bridge. ---
  app.post<{ Params: { id: string } }>("/internal/batches/:id/plan", async (req, reply) => {
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
  });
  app.post<{ Params: { id: string } }>("/internal/batches/:id/case", async (req, reply) => {
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
  });
  app.post<{ Params: { id: string } }>("/internal/batches/:id/finalize", async (req, reply) => {
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
  });

  app.post<{ Params: { id: string } }>("/internal/schedules/:id/fire", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z.object({ tenant: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      return reply.send(await deps.scheduleService.fire(body.data.tenant, req.params.id)); // { scorecardId, previousScorecardId? }
    } catch (err) {
      return sendError(reply, err); // missing schedule 404, firer not configured 400
    }
  });

  // Fire finalization — the workflow calls this after poll-to-terminal. Records the final status + a regression notification vs the previous run.
  app.post<{ Params: { id: string } }>("/internal/schedules/:id/finalize", async (req, reply) => {
    if (!deps.internalToken || !deps.scheduleService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "internal endpoints disabled" });
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || !constantTimeEq(provided, deps.internalToken))
      return reply.code(403).send({ code: "FORBIDDEN", message: "internal token mismatch" });
    const body = z
      .object({ tenant: z.string().min(1), scorecardId: z.string().min(1), previousScorecardId: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      await deps.scheduleService.finalize(
        body.data.tenant,
        req.params.id,
        body.data.scorecardId,
        body.data.previousScorecardId,
      );
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err); // missing schedule 404
    }
  });

  // Status of the fired scorecard (workflow poll-to-terminal). Internal only.
  app.get<{ Params: { scorecardId: string } }>(
    "/internal/schedules/scorecard-status/:scorecardId",
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
