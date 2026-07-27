import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { KnowledgeRelatedQuerySchema, KnowledgeSubgraphQuerySchema } from "./request/knowledge-query.js";
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
}
