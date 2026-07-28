import {
  KNOWLEDGE_ENTRY_MAX_REFS,
  KnowledgeEntryKindSchema,
  KnowledgeEntryStatusSchema,
  KnowledgeEntryVisibilitySchema,
  NodeRefSchema,
  NodeTypeSchema,
  PredicateSchema,
} from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

const DirectionSchema = z.enum(["out", "in", "both"]);

// Knowledge graph MCP tools — BFF parity with the /knowledge routes. The agent explores how a workspace's eval data
// connects: what a scorecard evaluated, which scorecards use a harness, what a change would impact.
export function registerKnowledgeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.knowledgeService) return;
  const knowledge = deps.knowledgeService;

  server.registerTool(
    "get_knowledge_node",
    {
      description:
        "Get one knowledge-graph node by its content-addressed id (e.g. 'harness:acme:web-agent@1.0.0', 'scorecard:acme:<id>').",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await knowledge.node(ws, id))),
  );

  server.registerTool(
    "knowledge_related",
    {
      description:
        "The 1-hop related facts of a node, ranked for display — {predicate, direction, nodeId, type, label, attrs}. Answers 'what did this scorecard use?' / 'which scorecards evaluate this harness?' (direction:'in').",
      inputSchema: {
        id: z.string().min(1),
        direction: DirectionSchema.optional().describe(
          "'out' (node is subject) | 'in' (node is object) | 'both' (default)",
        ),
        predicates: z.array(PredicateSchema).optional().describe("only these edge predicates"),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    ({ id, direction, predicates, limit }) =>
      run(principal, "scorecards:read", async () => {
        const opts: {
          direction?: z.infer<typeof DirectionSchema>;
          predicates?: z.infer<typeof PredicateSchema>[];
          limit?: number;
        } = {};
        if (direction !== undefined) opts.direction = direction;
        if (predicates !== undefined) opts.predicates = predicates;
        if (limit !== undefined) opts.limit = limit;
        return ok({ facts: await knowledge.related(ws, id, opts) });
      }),
  );

  server.registerTool(
    "knowledge_subgraph",
    {
      description:
        "Breadth-first subgraph from a node up to `depth` hops — {nodes, edges}. For impact analysis / neighbourhood exploration.",
      inputSchema: {
        id: z.string().min(1),
        depth: z.number().int().min(0).max(5).optional().describe("hops to expand (default 1)"),
        direction: DirectionSchema.optional(),
        predicates: z.array(PredicateSchema).optional(),
        node_types: z.array(NodeTypeSchema).optional().describe("restrict the returned nodes to these types"),
      },
    },
    ({ id, depth, direction, predicates, node_types }) =>
      run(principal, "scorecards:read", async () => {
        const query: {
          depth?: number;
          direction?: z.infer<typeof DirectionSchema>;
          predicates?: z.infer<typeof PredicateSchema>[];
          nodeTypes?: z.infer<typeof NodeTypeSchema>[];
        } = {};
        if (depth !== undefined) query.depth = depth;
        if (direction !== undefined) query.direction = direction;
        if (predicates !== undefined) query.predicates = predicates;
        if (node_types !== undefined) query.nodeTypes = node_types;
        return ok(await knowledge.subgraph(ws, id, query));
      }),
  );

  server.registerTool(
    "get_knowledge_graph",
    {
      description:
        "The whole workspace knowledge graph for an overview — {root, nodes, edges, stats:{totalNodes, totalEdges, nodesByType, edgesByPredicate}}. Rooted at the workspace hub node (no id needed). `depth` bounds the expansion: 1 = the star (workspace + all entities), 2 (default) also pulls in the inter-entity edges.",
      inputSchema: { depth: z.number().int().min(1).max(5).optional().describe("hops to expand (default 2)") },
    },
    ({ depth }) =>
      run(principal, "scorecards:read", async () =>
        ok(await knowledge.graph(ws, depth !== undefined ? { depth } : {})),
      ),
  );

  server.registerTool(
    "knowledge_notes",
    {
      description:
        "The authored notes/observations attached to a node (newest first) — the read side of annotate_knowledge.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok({ notes: await knowledge.notes(ws, id) })),
  );

  server.registerTool(
    "reindex_knowledge",
    {
      description:
        "Rebuild this workspace's knowledge graph by harvesting its existing records + registry entities (scorecards/runs/schedules + datasets/judges/runtimes/models/rubrics/harnesses/agents). Idempotent. Admin only.",
      inputSchema: {},
    },
    () => run(principal, "settings:write", async () => ok(await knowledge.reindex(ws))),
  );

  // --- authored write path: contribute knowledge from Claude Code ---

  server.registerTool(
    "annotate_knowledge",
    {
      description:
        "Attach a free-form note/observation to a node (e.g. 'this harness is flaky on network cases'). Author = me. The node is identified by {type, key, version?} — e.g. {type:'harness', key:'web-agent', version:'2.1.0'}.",
      inputSchema: {
        node: NodeRefSchema,
        note: z.string().min(1),
        confidence: z.number().min(0).max(1).optional().describe("how sure you are (default 1)"),
      },
    },
    ({ node, note, confidence }) =>
      run(principal, "comments:write", async () =>
        ok(await knowledge.annotate(ws, principal.subject, { node, note, confidence: confidence ?? 1 })),
      ),
  );

  server.registerTool(
    "get_task_context",
    {
      description:
        "Assemble workspace context for a task: for each anchor ({type, key, version?} — the entities the task concerns), the graph's related facts PLUS the workspace's knowledge entries (claims/decisions/conventions) and skill candidates ABOUT those anchors. The anchor's version IS the as-of coordinate: pass an old scorecard's harness@2.1.0 and the knowledge base is projected onto that point (unversioned anchors project onto the present). Each item carries its anchor relation — covers (confirmed at this coordinate) | earlier (about an earlier point; validity here unknown, not wrong) | later (from this coordinate's future, e.g. the eventual fix) | general (timeless family claim) — and a coverage state vs the present (current | behind | unverified). Call this BEFORE working on a harness/dataset/scorecard to inherit what the workspace already knows.",
      inputSchema: {
        refs: z.array(NodeRefSchema).min(1).max(KNOWLEDGE_ENTRY_MAX_REFS),
      },
    },
    ({ refs }) =>
      run(principal, "scorecards:read", async () => ok(await knowledge.assembleContext(ws, principal.subject, refs))),
  );

  server.registerTool(
    "relate_knowledge",
    {
      description:
        "Assert a typed relationship between two nodes over the closed predicate vocabulary (e.g. subject scorecard —compared_to→ object scorecard). Author = me. Re-asserting the same fact is idempotent. Subject/object are {type, key, version?}.",
      inputSchema: {
        subject: NodeRefSchema,
        predicate: PredicateSchema,
        object: NodeRefSchema,
        note: z.string().optional().describe("why / rationale (becomes the edge's evidence)"),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    ({ subject, predicate, object, note, confidence }) =>
      run(principal, "comments:write", async () =>
        ok(
          await knowledge.relate(ws, principal.subject, {
            subject,
            predicate,
            object,
            confidence: confidence ?? 1,
            ...(note !== undefined ? { note } : {}),
          }),
        ),
      ),
  );

  // --- knowledge entries: reified claims (annotate's promoted successor — multi-anchor, evidenced, revisable) ---

  const entries = deps.knowledgeEntryService;
  if (!entries) return;

  server.registerTool(
    "create_knowledge_entry",
    {
      description:
        "Contribute a knowledge entry — a durable claim about the workspace's entities: a finding ('harness X is flaky on k8s login cases'), a decision (+ rationale), a convention, or background context. `refs` = the version-pinned entities it concerns; `evidence` = the scorecards/runs/comments backing it; `supersedes` = the entry it revises. Defaults to a private draft — pass visibility:'workspace' to share.",
      inputSchema: {
        kind: KnowledgeEntryKindSchema,
        title: z.string().min(1).max(300).describe("the one-line claim itself"),
        body: z.string().min(1).describe("markdown — details, caveats, rationale"),
        refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        supersedes: z.string().min(1).optional(),
        visibility: KnowledgeEntryVisibilitySchema.optional(),
      },
    },
    ({ kind, title, body, refs, evidence, supersedes, visibility }) =>
      run(principal, "comments:write", async () =>
        ok(
          await entries.create({
            tenant: ws,
            createdBy: principal.subject,
            kind,
            title,
            body,
            ...(refs !== undefined ? { refs } : {}),
            ...(evidence !== undefined ? { evidence } : {}),
            ...(supersedes !== undefined ? { supersedes } : {}),
            ...(visibility !== undefined ? { visibility } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_knowledge_entries",
    {
      description:
        "The workspace's knowledge entries the caller can see (shared + own drafts), each with a coverage state vs the entities' present (current | behind | unverified). `behind` means the claim is as-of an earlier point — still true ABOUT that point; whether it extends to the present is what verify records.",
      inputSchema: {},
    },
    () => run(principal, "scorecards:read", async () => ok(await entries.list(ws, principal.subject))),
  );

  server.registerTool(
    "get_knowledge_entry",
    {
      description: "One knowledge entry by id (coverage-decorated).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await entries.get(ws, id, principal.subject))),
  );

  server.registerTool(
    "update_knowledge_entry",
    {
      description:
        "Edit a knowledge entry — re-pin refs, revise the body, change status (deprecate / mark superseded) or visibility. Manage = creator-or-admin.",
      inputSchema: {
        id: z.string().min(1),
        kind: KnowledgeEntryKindSchema.optional(),
        title: z.string().min(1).max(300).optional(),
        body: z.string().min(1).optional(),
        refs: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        evidence: z.array(NodeRefSchema).max(KNOWLEDGE_ENTRY_MAX_REFS).optional(),
        status: KnowledgeEntryStatusSchema.optional(),
        visibility: KnowledgeEntryVisibilitySchema.optional(),
      },
    },
    ({ id, kind, title, body, refs, evidence, status, visibility }) =>
      run(principal, "comments:write", async () =>
        ok(
          await entries.update(
            ws,
            id,
            {
              ...(kind !== undefined ? { kind } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(body !== undefined ? { body } : {}),
              ...(refs !== undefined ? { refs } : {}),
              ...(evidence !== undefined ? { evidence } : {}),
              ...(status !== undefined ? { status } : {}),
              ...(visibility !== undefined ? { visibility } : {}),
            },
            { subject: principal.subject, isAdmin: principal.roles.includes("admin") },
          ),
        ),
      ),
  );

  server.registerTool(
    "delete_knowledge_entry",
    {
      description: "Delete a knowledge entry. Manage = creator-or-admin.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () => {
        await entries.remove(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") });
        return ok({ deleted: true });
      }),
  );

  server.registerTool(
    "verify_knowledge_entry",
    {
      description:
        "Attest a knowledge entry still holds — EXTENDS each versioned pin's known-valid interval to the entity's current latest (verifiedVersion) plus the wall-clock verifiedAt, without counting as an edit. Use when a behind-flagged claim checks out at the present; if the claim no longer holds, create a superseding entry pinned at the version where it changed instead. Manage = creator-or-admin.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () =>
        ok(await entries.verify(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") })),
      ),
  );

  server.registerTool(
    "approve_knowledge_entry",
    {
      description:
        "Approve a PROPOSED knowledge entry (an extraction candidate awaiting review): status proposed → active, and authorship transfers to you — you now assert the claim and own its management (the extraction provenance stays for audit). Only proposed entries can be approved (409 otherwise).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () =>
        ok(await entries.approve(ws, id, { subject: principal.subject, isAdmin: principal.roles.includes("admin") })),
      ),
  );

  server.registerTool(
    "reject_knowledge_entry",
    {
      description:
        "Reject a PROPOSED knowledge entry — deletes the candidate. Only proposed entries can be rejected (an active claim is removed via delete_knowledge_entry, creator-or-admin).",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(principal, "comments:write", async () => {
        await entries.reject(ws, id);
        return ok({ rejected: true });
      }),
  );

  const extraction = deps.knowledgeExtraction;
  if (!extraction) return;

  server.registerTool(
    "extract_knowledge",
    {
      description:
        "Mine a discussion thread for durable, evidence-backed conclusions and store them as PROPOSED knowledge entries awaiting review (the accumulation loop's extraction leg). `source.id` may be any comment in the thread; `model` is a registered workspace model (a real billable call). Returns the created proposals plus dedupe stats — re-running on the same thread skips already-proposed claims. Review with list_knowledge_entries (status 'proposed') → approve_knowledge_entry / reject_knowledge_entry.",
      inputSchema: {
        source: z.object({ kind: z.literal("comment"), id: z.string().min(1) }),
        model: z.string().min(1),
      },
    },
    ({ source, model }) =>
      run(principal, "comments:write", async () =>
        ok(await extraction.extract(ws, principal.subject, { source, model })),
      ),
  );
}
