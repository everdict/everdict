import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import {
  AssembleContextBodySchema,
  CreateKnowledgeEntryBodySchema,
  UpdateKnowledgeEntryBodySchema,
} from "./request/knowledge-entry-write.js";
import {
  KnowledgeGraphQuerySchema,
  KnowledgeRelatedQuerySchema,
  KnowledgeSubgraphQuerySchema,
} from "./request/knowledge-query.js";
import { AnnotateKnowledgeBodySchema, RelateKnowledgeBodySchema } from "./request/knowledge-write.js";

// Knowledge graph — the workspace's runs/scorecards/schedules/registry entities projected into a queryable graph of
// nodes + typed edges. Read = scorecards:read (the graph is derived from eval data); reindex = settings:write (an
// admin maintenance op that rebuilds the graph from current records). See docs/architecture/knowledge-graph.md.
export function registerKnowledgeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // A single node by its content-addressed id (e.g. "harness:acme:web-agent@1.0.0").
  app.get("/knowledge/node", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const id = (req.query as { id?: string }).id;
    if (!id) return reply.code(400).send({ code: "BAD_REQUEST", message: "id query param is required." });
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.knowledgeService.node(principal.workspace, id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A node's 1-hop related facts, ranked for display: ?id=&direction=out|in|both&predicates=a,b&limit=N
  app.get("/knowledge/related", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = KnowledgeRelatedQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "scorecards:read");
      const facts = await deps.knowledgeService.related(principal.workspace, parsed.data.id, parsed.data);
      return reply.send({ facts });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A multi-hop subgraph from a node: ?id=&depth=N&direction=&predicates=a,b&nodeTypes=harness,dataset
  app.get("/knowledge/subgraph", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = KnowledgeSubgraphQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.knowledgeService.subgraph(principal.workspace, parsed.data.id, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The whole-workspace graph for rendering (Settings › Knowledge) — nodes + edges + counts, rooted at the workspace
  // hub node so the caller needs no node id: ?depth=1..5 (default 2).
  app.get("/knowledge/graph", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = KnowledgeGraphQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "scorecards:read");
      const opts = parsed.data.depth !== undefined ? { depth: parsed.data.depth } : {};
      return reply.send(await deps.knowledgeService.graph(principal.workspace, opts));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The authored notes attached to a node (the read side of /knowledge/annotate): ?id=
  app.get("/knowledge/annotations", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const id = (req.query as { id?: string }).id;
    if (!id) return reply.code(400).send({ code: "BAD_REQUEST", message: "id query param is required." });
    try {
      gate(principal, "scorecards:read");
      return reply.send({ notes: await deps.knowledgeService.notes(principal.workspace, id) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Rebuild this workspace's graph by harvesting its existing records (idempotent). Admin maintenance.
  app.post("/knowledge/reindex", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.knowledgeService.reindex(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Contribute knowledge — a free-form note on a node (author = the caller). member+.
  app.post("/knowledge/annotate", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = AnnotateKnowledgeBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "comments:write");
      return reply
        .code(201)
        .send(await deps.knowledgeService.annotate(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Contribute knowledge — assert a typed relationship between two nodes (closed predicate). member+.
  app.post("/knowledge/relate", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = RelateKnowledgeBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "comments:write");
      return reply
        .code(201)
        .send(await deps.knowledgeService.relate(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Task-time context assembly — per-anchor structural facts + the knowledge entries and skill candidates ABOUT the
  // anchors, freshness-decorated. POST because anchors are structured NodeRefs (keys may contain '/' / ':').
  app.post("/knowledge/context", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = AssembleContextBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      gate(principal, "scorecards:read");
      return reply.send(
        await deps.knowledgeService.assembleContext(principal.workspace, principal.subject, parsed.data.refs),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- knowledge entries: reified claims (the knowledge layer's record; annotate's promoted successor) ---
  // Reads = scorecards:read (like every knowledge read); writes = comments:write (a member contribution, like
  // annotate/relate); manage (edit/delete/verify) additionally gates creator-or-admin in the service.

  app.post("/knowledge/entries", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = CreateKnowledgeEntryBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.knowledgeEntryService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          ...parsed.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/knowledge/entries", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.knowledgeEntryService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.knowledgeEntryService.get(principal.workspace, req.params.id, principal.subject));
    } catch (err) {
      return sendError(reply, err); // foreign private / missing → 404
    }
  });

  app.patch<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = UpdateKnowledgeEntryBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.send(
        await deps.knowledgeEntryService.update(principal.workspace, req.params.id, parsed.data, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // creator-or-admin gate → 403/404
    }
  });

  app.delete<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      await deps.knowledgeEntryService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Attest a claim still holds — stamps verifiedAt without touching updatedAt (the freshness baseline).
  app.post<{ Params: { id: string } }>("/knowledge/entries/:id/verify", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      return reply.send(
        await deps.knowledgeEntryService.verify(principal.workspace, req.params.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
