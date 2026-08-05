import type { EdgeMention, KnowledgeNode, Mention, NodeType, Predicate, SourceKind } from "@everdict/contracts";

// Persistence port for the knowledge graph. The mention/edge tables are APPEND-ONLY and idempotent by id (a re-harvest
// writes the same rows); nodes are UPSERT-by-nodeId (a later, richer harvester replaces a stub). The read surface here
// is deliberately minimal — single-hop neighbours + a per-source mention lookup — the foundation the multi-hop query
// engine (a later step) composes over. Impls (InMemory*/Pg*) live in @everdict/db. See docs/architecture/knowledge-graph.md.
export interface KnowledgeStore {
  // Idempotent append (by id). Re-writing an existing id is a no-op — harvest can be re-run safely.
  putMentions(mentions: Mention[]): Promise<void>;
  putEdges(edges: EdgeMention[]): Promise<void>;
  // Upsert by nodeId (last writer wins — a richer projection replaces a stub of the same node).
  putNodes(nodes: KnowledgeNode[]): Promise<void>;
  // The node table is a DERIVED read-model (rebuilt from the mention spine), so reindex may retract projections whose
  // admission rule no longer holds — the execution stratum (run/scorecard) is materialised only while something
  // references it. The mention/edge spine stays append-only; only node rows are deleted.
  listNodeIds(tenant: string, types: NodeType[]): Promise<string[]>;
  deleteNodes(tenant: string, nodeIds: string[]): Promise<void>;

  getNode(tenant: string, nodeId: string): Promise<KnowledgeNode | undefined>;
  // Single-hop neighbours, optionally filtered by predicate. `outgoing` = edges where the node is the subject;
  // `incoming` = edges where it is the object. Both scoped to the tenant.
  outgoing(tenant: string, subjectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]>;
  incoming(tenant: string, objectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]>;
  // Every mention observed in one source — the audit trail for a record's projection.
  listMentions(tenant: string, sourceKind: SourceKind, sourceId: string): Promise<Mention[]>;
  // The AUTHORED notes attached to a node (origin="authored" mentions that resolved to it), newest first — the read
  // side of `annotate`. Backed by the mentions' resolved_node_id index.
  notesForNode(tenant: string, nodeId: string): Promise<Mention[]>;
}
