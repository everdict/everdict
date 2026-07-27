import { NodeTypeSchema, PredicateSchema } from "@everdict/contracts";
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
    "reindex_knowledge",
    {
      description:
        "Rebuild this workspace's knowledge graph by harvesting its existing records (scorecards/runs/schedules). Idempotent. Admin only.",
      inputSchema: {},
    },
    () => run(principal, "settings:write", async () => ok(await knowledge.reindex(ws))),
  );
}
