import { trajectoryReadableBy, trajectorySegmentsWire } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { trajectoryDocs } from "./trajectory.docs.js";

// PUT body — mirrors WorkspaceSettings.traceThresholds (full replacement, like every settings list).
// ── A FLAG THAT SILENTLY MEANS "NO" IS THE WRONG DIRECTION FOR THIS ONE (design review) ─────────────
//
// `resolve` was parsed as `=== "true" || === "1"`, copied from the notification route. This repo has two
// spellings for a boolean query param and the other one — `z.enum(["true","false"])`, used by cycle, team
// and fs — is what rule `api-layer` prescribes: validate, then 400. The difference matters more here than
// for a list filter: a caller asking `?resolve=yes` because they are AUDITING the evidence a verdict was
// reached on would silently receive the excerpt, which is the one answer this flag exists to let them
// avoid. Refused with a 400 naming the field.
const TrajectoryEventsQuerySchema = z.object({
  emitter: z.string().optional(),
  after: z
    .string()
    .regex(/^\d{1,9}$/)
    .optional(),
  limit: z
    .string()
    .regex(/^\d{1,9}$/)
    .optional(),
  resolve: z.enum(["true", "false"]).optional(),
});

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
  app.get<{ Querystring: { limit?: string; cursor?: string; kind?: string } }>(
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
            // The kind axis: "show me my agent conversations" among a workspace full of eval cases. Applied
            // in the store's query, beside the owner predicate, so the page never comes back short.
            ...(req.query.kind !== undefined && req.query.kind !== "" ? { kind: req.query.kind } : {}),
            // Personal evidence (an agent turn, a shell session) is its owner's — the store drops everyone
            // else's IN the query, so this page stays full for the reader.
            viewer: principal.subject,
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
  app.get<{
    Params: { id: string };
    Querystring: { emitter?: string; after?: string; limit?: string; resolve?: string };
  }>("/trajectories/:id", { schema: trajectoryDocs.get }, async (req, reply) => {
    if (!deps.trajectoryStore)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory store not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:read");
      const store = deps.trajectoryStore;
      const sealed = await store.planes(principal.workspace, req.params.id);
      // Another member's personal evidence answers exactly like a foreign workspace's — 404, no existence leak.
      if (!sealed || !trajectoryReadableBy(sealed.meta, principal.subject))
        return reply.code(404).send({ code: "NOT_FOUND", message: "trajectory not found." });
      // ONE PAGE of ONE plane. This route used to answer the whole trajectory with no way to ask for less,
      // which is what made opening a long-horizon run exhaust the shared process — see
      // docs/architecture/long-horizon-trace-reads.md.
      const query = TrajectoryEventsQuerySchema.safeParse(req.query);
      if (!query.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: "invalid query", data: zodIssues(query.error) });
      const after = query.data.after !== undefined ? Number.parseInt(query.data.after, 10) : undefined;
      const limit = query.data.limit !== undefined ? Number.parseInt(query.data.limit, 10) : undefined;
      // ── AND THE SEALED BYTES, IF THE CALLER ASKS FOR THEM (arch-review 120) ─────────────────
      //
      // An oversized payload is MOVED to object storage and the event keeps a preview plus an
      // `artifact://` ref. Until now no transport could dereference that ref and neither transport
      // forwarded `resolve`, so the whole offloaded tier was reachable only by internal scoring: a member
      // auditing the evidence a verdict was reached on saw a 32 KB excerpt and a ref string that resolved
      // to nothing. For a product whose deliverable is a defensible verdict, "show me what the judge read"
      // has to be answerable.
      //
      // Opt-in, never the default — a read that always resolved would undo the offload — and the store
      // clamps a resolving page to `MAX_RESOLVED_EVENT_PAGE`, because stored size does not predict
      // resolved size. Authorization is unchanged: the same `runs:read` and the same
      // `trajectoryReadableBy` above already decided this caller may read this trajectory, and resolving
      // reveals nothing the preview was hiding for authorization reasons.
      const resolve = query.data.resolve === "true";
      const page = await store.events(principal.workspace, req.params.id, {
        ...(query.data.emitter !== undefined && query.data.emitter !== "" ? { emitter: query.data.emitter } : {}),
        ...(after !== undefined && Number.isFinite(after) ? { after } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        ...(resolve ? { resolve: true } : {}),
      });
      if (page.kind === "too_large")
        // 409, never an empty page: a viewer handed "0 events" reads it as a run that did nothing, and that
        // is the strongest possible wrong answer to produce from a size limit.
        return reply.code(409).send({
          code: "CONFLICT",
          message: `Trajectory plane '${page.emitter}' is a ${page.storedBytes}-byte body sealed before it was split into events, over the ${page.limitBytes}-byte read ceiling. An operator splits it with scripts/live/split-trajectory-bodies.mjs.`,
          data: { emitter: page.emitter, storedBytes: page.storedBytes, limitBytes: page.limitBytes },
        });
      const { tenant: _tenant, ...meta } = sealed.meta; // the tenant is the caller's own — never echoed
      return reply.send({
        meta,
        events: page.kind === "page" ? page.page.events : [],
        segments: trajectorySegmentsWire(sealed),
        ...(page.kind === "page" && page.page.nextAfter !== undefined ? { nextAfter: page.page.nextAfter } : {}),
      });
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
