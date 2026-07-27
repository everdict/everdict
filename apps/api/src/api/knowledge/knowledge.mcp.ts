import { NodeRefSchema, NodeTypeSchema, PredicateSchema } from "@everdict/contracts";
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
}
