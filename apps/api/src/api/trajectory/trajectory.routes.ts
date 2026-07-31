import { trajectorySegmentsWire } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { trajectoryDocs } from "./trajectory.docs.js";

// PUT body — mirrors WorkspaceSettings.traceThresholds (full replacement, like every settings list).
const TraceThresholdsBodySchema = z.object({
  thresholds: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        metric: z.enum(["usd", "total_tokens", "llm_calls", "tool_calls", "tool_failures", "events", "latency_ms_max"]),
        value: z.number().nonnegative(),
      }),
    )
    .max(50),
});

// The owned trajectory ledger (N1): browse the sealed evidence, then open one. Envelope-free trivial reads —
// the routes call the store directly (the secrets-list precedent).
export function registerTrajectoryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/trajectories",
    { schema: trajectoryDocs.list },
    async (req, reply) => {
      if (!deps.trajectoryStore)
        return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory store not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "runs:read");
        const limit = req.query.limit !== undefined ? Number.parseInt(req.query.limit, 10) : undefined;
        return reply.send(
          await deps.trajectoryStore.list(principal.workspace, {
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            ...(req.query.cursor !== undefined && req.query.cursor !== "" ? { cursor: req.query.cursor } : {}),
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Detail over the SAME ledger: one sealed trajectory by the id it was sealed under. GET
  // /runs/:id/trajectory is run-scoped (it reads the run row first), so evidence that has no run row —
  // an otlp arrival keyed by the exporter's everdict.run_id, a materialized import keyed
  // ingest:<scorecardId>:<caseId> — could be listed but never opened. This route is the ledger's own
  // read: workspace-scoped, so another tenant's trajectory is 404 (no existence leak).
  app.get<{ Params: { id: string } }>("/trajectories/:id", { schema: trajectoryDocs.get }, async (req, reply) => {
    if (!deps.trajectoryStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const sealed = await deps.trajectoryStore.get(principal.workspace, req.params.id);
      if (!sealed) return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory not found." });
      const { tenant: _tenant, ...meta } = sealed.meta; // the tenant is the caller's own — never echoed
      return reply.send({ meta, events: sealed.events, segments: trajectorySegmentsWire(sealed) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Trace thresholds (E4 perception config): evaluated over every trajectory at seal time — a crossing
  // lands trace.threshold_crossed on the log. Envelope-free settings CRUD (the secrets precedent).
  app.get("/workspace/trace-thresholds", { schema: trajectoryDocs.thresholdsGet }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace settings not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const settings = await deps.settingsStore.get(principal.workspace);
      return reply.send({ thresholds: settings?.traceThresholds ?? [] });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Ingestion admission (N3): the OTLP door's events/hour quota + retention, readable by any member and
  // overridable per workspace. Usage comes from the store itself (the store IS the meter).
  app.get("/workspace/trace-ingestion", { schema: trajectoryDocs.ingestionGet }, async (req, reply) => {
    if (!deps.settingsStore || !deps.trajectoryStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace ingestion not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const settings = await deps.settingsStore.get(principal.workspace);
      const override = settings?.traceIngestion?.maxEventsPerHour;
      const operatorDefault = deps.traceIngestionConfig?.defaultMaxEventsPerHour;
      const used = await deps.trajectoryStore.ingestedSince(
        principal.workspace,
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      return reply.send({
        maxEventsPerHour: override ?? operatorDefault,
        source: override !== undefined ? "workspace" : operatorDefault !== undefined ? "operator" : "unlimited",
        usedLastHour: used.events,
        ...(deps.traceIngestionConfig?.retentionDays !== undefined
          ? { retentionDays: deps.traceIngestionConfig.retentionDays }
          : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-ingestion", { schema: trajectoryDocs.ingestionSet }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace settings not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      const parsed = z.object({ maxEventsPerHour: z.number().int().positive().nullable() }).safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      await deps.settingsStore.set(principal.workspace, {
        traceIngestion: parsed.data.maxEventsPerHour === null ? {} : { maxEventsPerHour: parsed.data.maxEventsPerHour },
      });
      return reply.send({
        maxEventsPerHour: parsed.data.maxEventsPerHour ?? undefined,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-thresholds", { schema: trajectoryDocs.thresholdsSet }, async (req, reply) => {
    if (!deps.settingsStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "workspace settings not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      const parsed = TraceThresholdsBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      await deps.settingsStore.set(principal.workspace, { traceThresholds: parsed.data.thresholds });
      return reply.send({ thresholds: parsed.data.thresholds });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
