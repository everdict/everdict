import type { KnowledgeStore } from "@everdict/application-control";
import type { EdgeMention, KnowledgeNode, Mention, NodeType, Predicate, SourceKind } from "@everdict/contracts";

// In-memory KnowledgeStore — the dev/test impl (the Pg impl + migrations are a later step). Mentions/edges are
// append-only and idempotent by id; nodes upsert by nodeId. Interchangeable with the future Pg impl by construction.
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly mentions = new Map<string, Mention>();
  private readonly edges = new Map<string, EdgeMention>();
  private readonly nodes = new Map<string, KnowledgeNode>();

  async putMentions(mentions: Mention[]): Promise<void> {
    for (const m of mentions) if (!this.mentions.has(m.id)) this.mentions.set(m.id, m); // idempotent append
  }

  async putEdges(edges: EdgeMention[]): Promise<void> {
    for (const e of edges) if (!this.edges.has(e.id)) this.edges.set(e.id, e); // idempotent append
  }

  async putNodes(nodes: KnowledgeNode[]): Promise<void> {
    for (const n of nodes) this.nodes.set(n.nodeId, n); // upsert by nodeId (last writer wins)
  }

  async getNode(tenant: string, nodeId: string): Promise<KnowledgeNode | undefined> {
    const n = this.nodes.get(nodeId);
    return n && n.tenant === tenant ? n : undefined;
  }

  async listNodeIds(tenant: string, types: NodeType[]): Promise<string[]> {
    return [...this.nodes.values()].filter((n) => n.tenant === tenant && types.includes(n.type)).map((n) => n.nodeId);
  }

  // Node rows are a derived read-model — reindex retracts execution projections whose admission went away. The
  // mention/edge spine stays append-only (audit); only the node row is deleted.
  async deleteNodes(tenant: string, nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) {
      const n = this.nodes.get(id);
      if (n !== undefined && n.tenant === tenant) this.nodes.delete(id);
    }
  }

  async outgoing(tenant: string, subjectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]> {
    return [...this.edges.values()].filter(
      (e) =>
        e.tenant === tenant &&
        e.subjectNodeId === subjectNodeId &&
        (predicate === undefined || e.predicate === predicate),
    );
  }

  async incoming(tenant: string, objectNodeId: string, predicate?: Predicate): Promise<EdgeMention[]> {
    return [...this.edges.values()].filter(
      (e) =>
        e.tenant === tenant &&
        e.objectNodeId === objectNodeId &&
        (predicate === undefined || e.predicate === predicate),
    );
  }

  async listMentions(tenant: string, sourceKind: SourceKind, sourceId: string): Promise<Mention[]> {
    return [...this.mentions.values()].filter(
      (m) => m.tenant === tenant && m.sourceKind === sourceKind && m.sourceId === sourceId,
    );
  }

  async notesForNode(tenant: string, nodeId: string): Promise<Mention[]> {
    return [...this.mentions.values()]
      .filter((m) => m.tenant === tenant && m.resolvedNodeId === nodeId && m.origin === "authored")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
