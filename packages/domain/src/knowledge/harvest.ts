import type { EdgeMention, KnowledgeNode, Mention, NodeRef, Predicate, SourceKind } from "@everdict/contracts";
import { edgeId, mentionId, nodeId } from "./ids.js";

// What a harvester produces from one source record — the two spine layers plus the source's own canonical node.
export interface HarvestResult {
  nodes: KnowledgeNode[];
  mentions: Mention[];
  edges: EdgeMention[];
}

// HarvestBuilder — the shared, declarative core every STRUCTURED harvester uses to project one record into the graph.
// The pattern is always the same: a source record IS a node (`self`), and it REFERENCES other nodes through its
// foreign-key fields (`ref`). The builder emits, per reference, an object Mention (resolved — harvest knows the exact
// node) and an EdgeMention from self to it, all with `origin: "harvest"`, `confidence: 1.0`, and the record field path
// as evidence (the audit lock). Deterministic ids make the whole thing idempotent. Referenced object nodes are NOT
// materialised here — each entity's own harvester owns its node projection; edges point at the derived node id and the
// node row lands when that harvester runs (or is a dangling-but-known reference until then).
export class HarvestBuilder {
  private readonly mentions: Mention[] = [];
  private readonly edges: EdgeMention[] = [];
  private selfNode?: KnowledgeNode;
  private selfNodeId?: string;

  constructor(
    private readonly tenant: string,
    private readonly sourceKind: SourceKind,
    private readonly sourceId: string,
    private readonly extractor: string,
    private readonly observedAt: string,
    private readonly createdAt: string,
  ) {}

  // Declare the source's own node (the edge subject). `attrs` is a small display bag, never a copy of the record body.
  self(ref: NodeRef, label: string, attrs: Record<string, unknown> = {}): this {
    const id = nodeId(this.tenant, ref);
    this.selfNodeId = id;
    this.selfNode = {
      nodeId: id,
      tenant: this.tenant,
      type: ref.type,
      key: ref.key,
      ...(ref.version !== undefined ? { version: ref.version } : {}),
      label,
      attrs,
      resolution: "resolved",
      evidenceCount: 1,
      firstObservedAt: this.createdAt,
      lastObservedAt: this.observedAt,
      createdAt: this.createdAt,
      updatedAt: this.observedAt,
    };
    this.mentions.push(this.mention(ref, "id"));
    return this;
  }

  // Declare a reference from self to another node via `predicate`, cited to the record field at `evidencePath`.
  // `objectTenant` overrides the tenant the object node id is derived under — for a CROSS-TENANT reference (an agent
  // adopting a `subset`/`public` capability owned by another workspace). Defaults to this source's own tenant.
  ref(
    predicate: Predicate,
    objectRef: NodeRef,
    evidencePath: string,
    edgeAttrs: Record<string, unknown> = {},
    objectTenant: string = this.tenant,
  ): this {
    if (this.selfNodeId === undefined) throw new Error("HarvestBuilder.ref called before self()");
    const objectNodeId = nodeId(objectTenant, objectRef);
    this.mentions.push(this.mention(objectRef, evidencePath, objectTenant));
    this.edges.push({
      id: edgeId({
        sourceKind: this.sourceKind,
        sourceId: this.sourceId,
        predicate,
        subject: this.selfNodeId,
        object: objectNodeId,
        extractor: this.extractor,
      }),
      tenant: this.tenant,
      predicate,
      subjectNodeId: this.selfNodeId,
      objectNodeId,
      objectTypeHint: objectRef.type,
      edgeAttrs,
      polarity: "affirmed",
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      origin: "harvest",
      extractor: this.extractor,
      confidence: 1,
      evidencePath,
      resolution: "resolved",
      createdAt: this.createdAt,
    });
    return this;
  }

  result(): HarvestResult {
    if (this.selfNode === undefined) throw new Error("HarvestBuilder.result called before self()");
    return { nodes: [this.selfNode], mentions: this.mentions, edges: this.edges };
  }

  private mention(ref: NodeRef, evidencePath: string, resolvedTenant: string = this.tenant): Mention {
    const surface = ref.version === undefined ? ref.key : `${ref.key}@${ref.version}`;
    return {
      id: mentionId({
        sourceKind: this.sourceKind,
        sourceId: this.sourceId,
        nodeType: ref.type,
        nodeRef: surface,
        extractor: this.extractor,
      }),
      tenant: this.tenant,
      nodeType: ref.type,
      nodeRef: surface,
      nodeAttrs: {},
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      origin: "harvest",
      extractor: this.extractor,
      confidence: 1,
      evidencePath,
      resolution: "resolved",
      resolvedNodeId: nodeId(resolvedTenant, ref),
      createdAt: this.createdAt,
    };
  }
}
