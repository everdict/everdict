import { randomUUID } from "node:crypto";
import {
  BadRequestError,
  type EdgeMention,
  EdgeMentionSchema,
  type KnowledgeNode,
  type Mention,
  MentionSchema,
  type NodeRef,
  NotFoundError,
  type Predicate,
} from "@everdict/contracts";
import {
  type HarvestResult,
  type SpecHarvestMeta,
  edgeId,
  harvestAgent,
  harvestDataset,
  harvestHarness,
  harvestJudge,
  harvestModel,
  harvestRubric,
  harvestRun,
  harvestRuntime,
  harvestSchedule,
  harvestScorecard,
  nodeId,
} from "@everdict/domain";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeRegistry } from "../ports/runtime-registry.js";
import type { ScheduleStore } from "../ports/schedule-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { ingestHarvest } from "./ingest-harvest.js";
import {
  KnowledgeQueryService,
  type NeighborQuery,
  type RelatedFact,
  type Subgraph,
  type TraversalDirection,
} from "./knowledge-query-service.js";

// The sources a reindex harvests. Records (scorecards/runs/schedules) list all rows by tenant; the versioned registries
// materialise their eval-config NODES by harvesting each entity's LATEST version. Comments are excluded — CommentStore
// has no list-all; capability adoption is captured via the agent harvester (the CapabilityStore has a distinct API).
export interface KnowledgeReindexSources {
  scorecards?: Pick<ScorecardStore, "list">;
  runs?: Pick<RunStore, "list">;
  schedules?: Pick<ScheduleStore, "list">;
  datasets?: DatasetRegistry;
  judges?: JudgeRegistry;
  runtimes?: RuntimeRegistry;
  models?: ModelRegistry;
  rubrics?: RubricRegistry;
  harnesses?: HarnessInstanceRegistry;
  agents?: AgentRegistry;
}

export interface KnowledgeReindexResult {
  scanned: number;
  nodes: number;
  edges: number;
}

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  reindexSources?: KnowledgeReindexSources;
}

// The control-plane facade over the knowledge graph — the read surface (node / related / subgraph, delegating to the
// KnowledgeQueryService) plus a pull-based reindex that harvests the workspace's existing records + registry entities
// into the graph (idempotent, so it is safe to re-run). Both transports (HTTP routes + MCP tools) call this one service.
export class KnowledgeService {
  private readonly query: KnowledgeQueryService;

  constructor(private readonly deps: KnowledgeServiceDeps) {
    this.query = new KnowledgeQueryService(deps.store);
  }

  // A single node — 404 when absent (an unknown or not-yet-harvested id).
  async node(tenant: string, nodeId: string): Promise<KnowledgeNode> {
    const n = await this.deps.store.getNode(tenant, nodeId);
    if (n === undefined) throw new NotFoundError("NOT_FOUND", { nodeId }, `knowledge node '${nodeId}' not found.`);
    return n;
  }

  related(
    tenant: string,
    nodeId: string,
    opts?: { direction?: TraversalDirection; predicates?: Predicate[]; limit?: number },
  ): Promise<RelatedFact[]> {
    return this.query.relatedFacts(tenant, nodeId, opts ?? {});
  }

  subgraph(tenant: string, nodeId: string, query?: NeighborQuery): Promise<Subgraph> {
    return this.query.subgraph(tenant, nodeId, query ?? {});
  }

  // The authored notes on a node (the read side of `annotate`), newest first.
  notes(tenant: string, nodeId: string): Promise<Mention[]> {
    return this.deps.store.notesForNode(tenant, nodeId);
  }

  // Harvest the workspace's existing records + registry entities into the graph. Idempotent (the harvesters emit
  // deterministic ids), so a re-run reconciles rather than duplicates. Registry entities are harvested at their LATEST
  // version; the registration timestamp is unavailable uniformly, so the node's observation time is the reindex moment.
  async reindex(tenant: string): Promise<KnowledgeReindexResult> {
    const src = this.deps.reindexSources;
    const stamp = new Date().toISOString();
    const acc: KnowledgeReindexResult = { scanned: 0, nodes: 0, edges: 0 };
    const apply = async (h: HarvestResult): Promise<void> => {
      await ingestHarvest(this.deps.store, h);
      acc.scanned += 1;
      acc.nodes += h.nodes.length;
      acc.edges += h.edges.length;
    };
    const meta = (createdBy?: string): SpecHarvestMeta =>
      createdBy !== undefined && createdBy !== ""
        ? { tenant, createdAt: stamp, updatedAt: stamp, createdBy }
        : { tenant, createdAt: stamp, updatedAt: stamp };

    // Record stores.
    if (src?.scorecards) for (const sc of await src.scorecards.list(tenant)) await apply(harvestScorecard(sc));
    if (src?.runs) for (const r of await src.runs.list(tenant, { includeChildren: true })) await apply(harvestRun(r));
    if (src?.schedules) for (const s of await src.schedules.list(tenant)) await apply(harvestSchedule(s));

    // Versioned registries — harvest each entity's latest version.
    if (src?.datasets) {
      for (const e of await src.datasets.list(tenant))
        await apply(harvestDataset(meta(e.createdBy), await src.datasets.get(tenant, e.id)));
    }
    if (src?.judges) {
      for (const e of await src.judges.list(tenant))
        await apply(harvestJudge(meta(e.createdBy), await src.judges.get(tenant, e.id)));
    }
    if (src?.runtimes) {
      for (const e of await src.runtimes.list(tenant))
        await apply(harvestRuntime(meta(), await src.runtimes.get(tenant, e.id)));
    }
    if (src?.models) {
      for (const e of await src.models.list(tenant))
        await apply(harvestModel(meta(e.createdBy), await src.models.get(tenant, e.id)));
    }
    if (src?.rubrics) {
      for (const e of await src.rubrics.list(tenant))
        await apply(harvestRubric(meta(e.createdBy), await src.rubrics.get(tenant, e.id)));
    }
    if (src?.harnesses) {
      for (const e of await src.harnesses.list(tenant))
        await apply(harvestHarness(meta(e.createdBy), await src.harnesses.get(tenant, e.id)));
    }
    if (src?.agents) {
      for (const e of await src.agents.list(tenant))
        await apply(harvestAgent(meta(e.createdBy), await src.agents.get(tenant, e.id)));
    }
    return acc;
  }

  // Attach a free-form note/observation to a node — a user or agent (from Claude Code via the everdict plugin)
  // contributing knowledge. Recorded as an `authored` mention (the note is its evidence). Multiple notes on the same
  // node coexist (each is a distinct contribution → a fresh id), unlike the idempotent harvest mentions.
  async annotate(
    tenant: string,
    author: string,
    input: { node: NodeRef; note: string; confidence: number },
  ): Promise<{ id: string; nodeId: string }> {
    const note = input.note.trim();
    if (note === "") throw new BadRequestError("BAD_REQUEST", {}, "a knowledge note must be non-empty.");
    const resolvedNodeId = nodeId(tenant, input.node);
    const surface = input.node.version === undefined ? input.node.key : `${input.node.key}@${input.node.version}`;
    const mention: Mention = MentionSchema.parse({
      id: `mtn_authored_${randomUUID()}`,
      tenant,
      nodeType: input.node.type,
      nodeRef: surface,
      nodeAttrs: { note, author },
      sourceKind: "authored",
      sourceId: author,
      origin: "authored",
      extractor: "authored_v1",
      confidence: input.confidence,
      evidenceQuote: note,
      resolution: "resolved",
      resolvedNodeId,
      createdAt: new Date().toISOString(),
    } satisfies Mention);
    await this.deps.store.putMentions([mention]);
    return { id: mention.id, nodeId: resolvedNodeId };
  }

  // Assert a typed relationship between two nodes — an `authored` edge over the CLOSED predicate vocabulary. Idempotent
  // by (author, subject, predicate, object): re-asserting the same fact is a no-op (the deterministic id collides), so
  // the graph does not accrue duplicate authored edges.
  async relate(
    tenant: string,
    author: string,
    input: { subject: NodeRef; predicate: Predicate; object: NodeRef; note?: string; confidence: number },
  ): Promise<{ id: string }> {
    const subjectNodeId = nodeId(tenant, input.subject);
    const objectNodeId = nodeId(tenant, input.object);
    if (subjectNodeId === objectNodeId) throw new BadRequestError("BAD_REQUEST", {}, "cannot relate a node to itself.");
    const note = (input.note ?? "").trim();
    const extractor = "authored_v1";
    const edge: EdgeMention = EdgeMentionSchema.parse({
      id: edgeId({
        sourceKind: "authored",
        sourceId: author,
        predicate: input.predicate,
        subject: subjectNodeId,
        object: objectNodeId,
        extractor,
      }),
      tenant,
      predicate: input.predicate,
      subjectNodeId,
      objectNodeId,
      subjectTypeHint: input.subject.type,
      objectTypeHint: input.object.type,
      edgeAttrs: { author },
      polarity: "affirmed",
      sourceKind: "authored",
      sourceId: author,
      origin: "authored",
      extractor,
      confidence: input.confidence,
      evidenceQuote: note !== "" ? note : `asserted by ${author}`,
      resolution: "resolved",
      createdAt: new Date().toISOString(),
    } satisfies EdgeMention);
    await this.deps.store.putEdges([edge]);
    return { id: edge.id };
  }
}
