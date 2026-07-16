import { SpanAttrMappingSchema } from "@everdict/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { traceSourceDocs } from "./trace-source.docs.js";

// workspace trace sources (multiple) — pull a dev-cluster-deployed harness's trace from its observability platform
// after a case runs, for grading/judging + the per-harness source selection. The inbound mirror of trace sinks.
export function registerTraceSourceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Read harnesses:read (viewer+ — the view is a name reference/URL only) / register·unregister settings:write /
  // per-harness selection harnesses:register (member+ — part of the harness config). Design: docs/service-harness.md
  app.get("/workspace/trace-sources", { schema: traceSourceDocs.list }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      return reply.send(await deps.traceSourceService.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/workspace/trace-sources", { schema: traceSourceDocs.upsert }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        name: z.string().min(1),
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(),
        authSecretName: z.string().min(1).optional(),
        correlate: z.enum(["id", "tag"]).optional(),
        service: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        webUrl: z.string().url().optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      const config = await deps.traceSourceService.upsert(principal.workspace, body.data);
      return reply.send({ config });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Connection test + scope discovery before registering — validate the base URL + resolved secret and list the
  // platform's selectable scopes (mlflow experiments / phoenix|langfuse|langsmith projects / otel[jaeger] services).
  // settings:write (same as register — the probe resolves the workspace secret). A classified failure is still a 200.
  app.post("/workspace/trace-sources/probe", { schema: traceSourceDocs.probe }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = z
      .object({
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(),
        authSecretName: z.string().min(1).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.traceSourceService.probe(principal.workspace, body.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/workspace/trace-sources/:name", { schema: traceSourceDocs.remove }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    try {
      gate(principal, "settings:write");
      await deps.traceSourceService.remove(principal.workspace, name);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-harness PULL selection — which registered source to pull this harness's case traces from. source:null = deselect.
  app.put("/harnesses/:id/trace-source", { schema: traceSourceDocs.assign }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ source: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const assignments = await deps.traceSourceService.assignSource(principal.workspace, id, body.data.source);
      return reply.send({ assignments });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Per-harness EXPORT selection — which registered source to export this harness's judged results to (the source used
  // as an export target; a sink-capable kind, not otel). source:null = deselect (export off). Same pool, use-site choice.
  app.put("/harnesses/:id/trace-sink", { schema: traceSourceDocs.assignSink }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ source: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const assignments = await deps.traceSourceService.assignSink(principal.workspace, id, body.data.source);
      return reply.send({ assignments });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Observability browser: enumerate a registered source's recent traces + their metrics (the list the judge wizard
  // picks a sample from, and the settings traces view). Read-scoped (harnesses:read).
  app.get("/workspace/trace-sources/:name/traces", { schema: traceSourceDocs.listTraces }, async (req, reply) => {
    if (!deps.traceSourceService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { name } = req.params as { name: string };
    const query = z
      .object({
        scope: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
        since: z.string().min(1).optional(),
      })
      .safeParse(req.query ?? {});
    if (!query.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(query.error).join("; ") });
    try {
      gate(principal, "harnesses:read");
      const traces = await deps.traceSourceService.listTraces(principal.workspace, name, query.data);
      return reply.send({ traces });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Inspect one trace by id — raw span attributes (span-based kinds) + events normalized with the SUPPLIED mapping.
  // Powers the wizard's live conversion-authoring loop. Read-scoped (a supplied mapping is transient, not persisted here).
  app.post(
    "/workspace/trace-sources/:name/traces/:traceId/inspect",
    { schema: traceSourceDocs.inspect },
    async (req, reply) => {
      if (!deps.traceSourceService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "trace source service not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { name, traceId } = req.params as { name: string; traceId: string };
      const body = z.object({ mapping: SpanAttrMappingSchema.optional() }).safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
      try {
        gate(principal, "harnesses:read");
        return reply.send(await deps.traceSourceService.inspect(principal.workspace, name, traceId, body.data.mapping));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Per-harness span-attribute mapping overlay (the conversion layer between a harness and a judge). Read = harnesses:read.
  app.get("/harnesses/:id/span-attr-mapping", { schema: traceSourceDocs.getMapping }, async (req, reply) => {
    if (!deps.spanAttrMappingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "span-attr mapping service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    try {
      gate(principal, "harnesses:read");
      const mapping = await deps.spanAttrMappingService.get(principal.workspace, id);
      return reply.send({ mapping: mapping ?? null });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Set/clear the overlay (member+, part of the harness config — same gate as trace-source selection). mapping:null clears.
  app.put("/harnesses/:id/span-attr-mapping", { schema: traceSourceDocs.setMapping }, async (req, reply) => {
    if (!deps.spanAttrMappingService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "span-attr mapping service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ mapping: SpanAttrMappingSchema.nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(body.error).join("; ") });
    try {
      gate(principal, "harnesses:register");
      const mappings = await deps.spanAttrMappingService.assign(principal.workspace, id, body.data.mapping);
      return reply.send({ mappings });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
