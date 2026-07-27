import type { EdgeMention, KnowledgeNode, NodeType, Predicate } from "@everdict/contracts";
import { predicateRank } from "@everdict/domain";
import type { KnowledgeStore } from "../ports/knowledge-store.js";

// The multi-hop query engine over the knowledge graph — the store-agnostic traversal that turns the harvested spine
// into answers ("what did this scorecard use", "which scorecards evaluate this harness", "everything reachable from
// this node in 2 hops"). Drives the KnowledgeStore's single-hop primitives in a breadth-first loop, so it works
// identically over the in-memory and (future) Postgres impls. A Pg-native recursive-CTE fast path can slot in later
// behind the same surface. See docs/architecture/knowledge-graph.md §multi-hop query engine.

export type TraversalDirection = "out" | "in" | "both";

const MAX_DEPTH = 5; // hard cap — a request for more collapses to this
const MAX_NODES = 500; // frontier explosion guard

export interface NeighborQuery {
  depth?: number; // hops to expand (default 1, capped at MAX_DEPTH)
  direction?: TraversalDirection; // default "both"
  predicates?: Predicate[]; // only traverse these predicates (any-match; default all)
  nodeTypes?: NodeType[]; // restrict the RETURNED nodes to these types (edges are unfiltered)
}

// A reached region of the graph: the traversed edges + the node rows that back their endpoints (a dangling endpoint —
// an edge to a not-yet-materialised node — contributes its edge but no node row).
export interface Subgraph {
  root: string;
  nodes: KnowledgeNode[];
  edges: EdgeMention[];
}

// One 1-hop relationship of a node, flattened for rendering — the everdict analog of digo-data's CityKnowledgeFact.
// `direction` says whether the root is the subject ("out") or object ("in") of the edge.
export interface RelatedFact {
  predicate: Predicate;
  direction: "out" | "in";
  nodeId: string; // the OTHER endpoint
  type?: NodeType; // the other endpoint's type (from its node row or the edge type hint)
  label?: string; // the other endpoint's display label (if its node row exists)
  attrs: Record<string, unknown>; // the edge's attributes
}

export class KnowledgeQueryService {
  constructor(private readonly store: KnowledgeStore) {}

  // Breadth-first expansion from `root` up to `depth` hops.
  async subgraph(tenant: string, root: string, query: NeighborQuery = {}): Promise<Subgraph> {
    const depth = Math.min(Math.max(query.depth ?? 1, 0), MAX_DEPTH);
    const direction = query.direction ?? "both";
    const predicateFilter = query.predicates ? new Set<Predicate>(query.predicates) : undefined;

    const visited = new Set<string>([root]);
    const edgeById = new Map<string, EdgeMention>();
    let frontier: string[] = [root];

    for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < MAX_NODES; hop++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const e of await this.edgesOf(tenant, nodeId, direction, predicateFilter)) {
          edgeById.set(e.id, e);
          const other = otherEndpoint(e, nodeId);
          if (other !== undefined && !visited.has(other) && visited.size < MAX_NODES) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const nodeRows = await Promise.all([...visited].map((id) => this.store.getNode(tenant, id)));
    let nodes = nodeRows.filter((n): n is KnowledgeNode => n !== undefined);
    if (query.nodeTypes) {
      const allow = new Set<NodeType>(query.nodeTypes);
      nodes = nodes.filter((n) => allow.has(n.type));
    }
    return { root, nodes, edges: [...edgeById.values()] };
  }

  // The 1-hop related facts of a node, ranked for display (predicate priority, then evidence-bearing edges first).
  async relatedFacts(
    tenant: string,
    root: string,
    opts: { direction?: TraversalDirection; predicates?: Predicate[]; limit?: number } = {},
  ): Promise<RelatedFact[]> {
    const direction = opts.direction ?? "both";
    const predicateFilter = opts.predicates ? new Set<Predicate>(opts.predicates) : undefined;
    const edges = await this.edgesOf(tenant, root, direction, predicateFilter);

    const facts = await Promise.all(
      edges.map(async (e): Promise<RelatedFact | undefined> => {
        const isSubject = e.subjectNodeId === root;
        const otherId = isSubject ? e.objectNodeId : e.subjectNodeId;
        if (otherId === undefined) return undefined; // mention-referenced (pre-resolution) edge — not in the node graph yet
        const other = await this.store.getNode(tenant, otherId);
        const fact: RelatedFact = {
          predicate: e.predicate,
          direction: isSubject ? "out" : "in",
          nodeId: otherId,
          attrs: e.edgeAttrs,
        };
        const type = other?.type ?? (isSubject ? e.objectTypeHint : e.subjectTypeHint);
        if (type !== undefined) fact.type = type;
        if (other !== undefined) fact.label = other.label;
        return fact;
      }),
    );

    const ranked = facts
      .filter((f): f is RelatedFact => f !== undefined)
      .sort((a, b) => predicateRank(a.predicate) - predicateRank(b.predicate));
    return opts.limit !== undefined ? ranked.slice(0, opts.limit) : ranked;
  }

  private async edgesOf(
    tenant: string,
    nodeId: string,
    direction: TraversalDirection,
    predicateFilter: Set<Predicate> | undefined,
  ): Promise<EdgeMention[]> {
    const collected: EdgeMention[] = [];
    if (direction === "out" || direction === "both") collected.push(...(await this.store.outgoing(tenant, nodeId)));
    if (direction === "in" || direction === "both") collected.push(...(await this.store.incoming(tenant, nodeId)));
    return predicateFilter === undefined ? collected : collected.filter((e) => predicateFilter.has(e.predicate));
  }
}

// The endpoint of `e` that is NOT `nodeId` — the neighbour to step to. Only node-referenced edges (the resolved graph)
// participate; a purely mention-referenced edge returns undefined.
function otherEndpoint(e: EdgeMention, nodeId: string): string | undefined {
  if (e.subjectNodeId === nodeId) return e.objectNodeId;
  if (e.objectNodeId === nodeId) return e.subjectNodeId;
  return undefined;
}
