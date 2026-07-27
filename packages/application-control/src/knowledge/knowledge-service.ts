import { type KnowledgeNode, NotFoundError, type Predicate } from "@everdict/contracts";
import { type HarvestResult, harvestRun, harvestSchedule, harvestScorecard } from "@everdict/domain";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import type { RunStore } from "../ports/run-store.js";
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

// The record stores a reindex reads from (only the ones listable by tenant). Comments are excluded — CommentStore has
// no list-all (it lists per resource), so comment edges arrive via the ingest-on-write path, not the pull reindex.
export interface KnowledgeReindexSources {
  scorecards?: Pick<ScorecardStore, "list">;
  runs?: Pick<RunStore, "list">;
  schedules?: Pick<ScheduleStore, "list">;
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
// KnowledgeQueryService) plus a pull-based reindex that harvests the workspace's existing records into the graph
// (idempotent, so it is safe to re-run). Both transports (HTTP routes + MCP tools) call this one service.
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

  // Harvest the workspace's existing records into the graph. Idempotent (the harvesters emit deterministic ids), so a
  // re-run reconciles rather than duplicating. Only the tenant-listable record stores participate.
  async reindex(tenant: string): Promise<KnowledgeReindexResult> {
    const src = this.deps.reindexSources;
    const acc: KnowledgeReindexResult = { scanned: 0, nodes: 0, edges: 0 };
    const apply = async (h: HarvestResult): Promise<void> => {
      await ingestHarvest(this.deps.store, h);
      acc.scanned += 1;
      acc.nodes += h.nodes.length;
      acc.edges += h.edges.length;
    };
    if (src?.scorecards) for (const sc of await src.scorecards.list(tenant)) await apply(harvestScorecard(sc));
    if (src?.runs) for (const r of await src.runs.list(tenant, { includeChildren: true })) await apply(harvestRun(r));
    if (src?.schedules) for (const s of await src.schedules.list(tenant)) await apply(harvestSchedule(s));
    return acc;
  }
}
