import { randomUUID } from "node:crypto";
import {
  BadRequestError,
  type EdgeMention,
  EdgeMentionSchema,
  type KnowledgeNode,
  type Mention,
  MentionSchema,
  type NodeRef,
  type NodeType,
  NotFoundError,
  type Predicate,
} from "@everdict/contracts";
import type { KnowledgeEntryRecord, KnowledgePin } from "@everdict/contracts";
import type { CapabilityOrigin } from "@everdict/contracts";
import {
  type AnchorRelation,
  type Coverage,
  type HarvestResult,
  type SpecHarvestMeta,
  anchorRelation,
  edgeId,
  harvestAgent,
  harvestDataset,
  harvestHarness,
  harvestInitiative,
  harvestIssue,
  harvestJudge,
  harvestKnowledgeEntry,
  harvestModel,
  harvestProject,
  harvestRubric,
  harvestRun,
  harvestRuntime,
  harvestSchedule,
  harvestScorecard,
  harvestSkill,
  nodeId,
} from "@everdict/domain";
import type { AgentRegistry } from "../ports/agent-registry.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import type { KnowledgeStore } from "../ports/knowledge-store.js";
import type { ModelRegistry } from "../ports/model-registry.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeRegistry } from "../ports/runtime-registry.js";
import type { ScheduleStore } from "../ports/schedule-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { SkillStore } from "../ports/skill-store.js";
import { type LatestVersionResolver, resolveCoverage } from "./freshness-resolver.js";
import { ingestHarvest } from "./ingest-harvest.js";
import {
  KnowledgeQueryService,
  type NeighborQuery,
  type RelatedFact,
  type Subgraph,
  type TraversalDirection,
} from "./knowledge-query-service.js";

// The sources a reindex harvests. Records list all rows by tenant; the versioned registries materialise their
// eval-config NODES by harvesting each entity's LATEST version. Comments are excluded — CommentStore has no list-all;
// capability adoption is captured via the agent harvester (the CapabilityStore has a distinct API).
//
// EXECUTION ADMISSION RULE: run/scorecard records are high-cardinality outcomes, and a graph that materialises them
// wholesale drowns the strata a workspace reads it for (they dominated the map's render cap). An execution record is
// therefore materialised ONLY while something references it — an issue link, an issue resolution, a knowledge entry's
// refs/evidence, a skill's refs, a capability version's origin — and a reindex PRUNES execution nodes whose reference
// went away (the node table is a derived read-model; the mention/edge audit spine is never touched). The graph's
// execution nodes are EVIDENCE, by design: "recent runs of this harness" stays a RunStore question.
export interface KnowledgeReindexSources {
  scorecards?: Pick<ScorecardStore, "list">;
  runs?: Pick<RunStore, "list">;
  schedules?: Pick<ScheduleStore, "list">;
  // The intent stratum — the eval tracker. Issues are the graph's hub, and their links/resolutions are the main
  // admission gate for the execution stratum above.
  issues?: Pick<IssueStore, "list">;
  projects?: Pick<ProjectStore, "list">;
  initiatives?: Pick<InitiativeStore, "list">;
  datasets?: Pick<DatasetRegistry, "list" | "get">;
  judges?: Pick<JudgeRegistry, "list" | "get">;
  runtimes?: Pick<RuntimeRegistry, "list" | "get">;
  models?: Pick<ModelRegistry, "list" | "get">;
  rubrics?: Pick<RubricRegistry, "list" | "get">;
  harnesses?: Pick<HarnessInstanceRegistry, "list" | "get">;
  agents?: Pick<AgentRegistry, "list" | "get">;
  // Knowledge-layer records — only WORKSPACE-visible ones enter the shared graph (a private draft is personal until
  // its author shares it). Listed with an empty subject so no private rows leak into the projection.
  skills?: Pick<SkillStore, "list">;
  knowledgeEntries?: Pick<KnowledgeEntryStore, "list">;
}

export interface KnowledgeReindexResult {
  scanned: number;
  nodes: number;
  edges: number;
  // Execution nodes retracted because nothing references them any more (the admission rule above).
  pruned: number;
}

// The whole-workspace graph projection for rendering (Settings › Knowledge): the reachable nodes + edges plus derived
// counts by node type / predicate for the overview. A read-model over the query engine — no new store surface.
//
// The edge shape is deliberately the RENDER shape, not the stored `EdgeMention`: this payload ships whole to a
// browser, and at ~250 nodes the audit spine (origin/extractor/confidence/evidencePath/sourceKind/sourceId/tenant/
// createdAt on every edge) was two thirds of a 640 KB response. Provenance has its own surfaces — `related`,
// `node`, `listMentions` — which is where an auditor (or an agent) asks who observed a relationship and from what.
export interface KnowledgeGraphEdge {
  id: string;
  predicate: Predicate;
  subjectNodeId: string;
  objectNodeId: string;
  subjectTypeHint?: NodeType;
  objectTypeHint?: NodeType;
  polarity: EdgeMention["polarity"];
  // Predicate-specific display attributes — `about` carries the claim's [asOf, verifiedVersion] interval, which is
  // the one thing a renderer reads off an edge.
  edgeAttrs: Record<string, unknown>;
}

export interface KnowledgeGraphResult {
  root: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeGraphEdge[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Partial<Record<NodeType, number>>;
    edgesByPredicate: Partial<Record<Predicate, number>>;
  };
}

// The sources task-time context assembly reads. Unlike reindex (graph projection), assembleContext reads the
// RECORDS directly — always current, no reindex dependency on the hot path; the graph carries the same info for
// graph queries.
export interface KnowledgeContextSources {
  skills?: Pick<SkillStore, "list">;
  knowledgeEntries?: Pick<KnowledgeEntryStore, "list">;
  latestVersionOf?: LatestVersionResolver;
}

export interface KnowledgeServiceDeps {
  store: KnowledgeStore;
  reindexSources?: KnowledgeReindexSources;
  contextSources?: KnowledgeContextSources;
}

// One anchor's assembled context lane — the anchor + its ranked structural facts (which include `discusses` edges
// from harvested comments, so the discussion trail rides along).
export interface TaskContextAnchor {
  ref: NodeRef;
  nodeId: string;
  facts: RelatedFact[];
}

// A skill candidate in the assembled context — listing-level only (name/description/refs/coverage/relation), never
// the instructions body: selection stays cheap, the agent loads the body via use_skill when it picks one.
export interface TaskContextSkill {
  id: string;
  name: string;
  description: string;
  refs: KnowledgePin[];
  coverage?: Coverage;
  relation?: AnchorRelation;
}

// assembleContext's result — the one payload that feeds the in-product agent, spawned teammates/subagents, and
// Claude Code via the plugin (MCP get_task_context). Each knowledge/skill item carries its ANCHOR RELATION — where
// its known-valid interval sits relative to the anchor coordinate (`covers | earlier | later | general`): the
// anchor's own version IS the as-of coordinate (pass an old scorecard's harness@2.1.0 and the knowledge base is
// projected onto that point; an unversioned anchor projects onto the present). See knowledge-graph.md §The time axis.
export interface TaskContext {
  anchors: TaskContextAnchor[];
  knowledge: (KnowledgeEntryRecord & { coverage?: Coverage; relation?: AnchorRelation })[];
  skills: TaskContextSkill[];
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

  // The whole-workspace graph for rendering (Settings › Knowledge). Rooted at the workspace HUB node — every harvested
  // entity carries an `in_workspace` edge to it — so a bounded BFS from it reaches the workspace's knowledge. depth 1 is
  // the star (workspace + all entities); depth ≥2 also pulls in the inter-entity edges (scorecard→harness,
  // run→scorecard, member_of, …). Bounded by the query engine's MAX_NODES frontier guard. Read = scorecards:read.
  //
  // The KNOWLEDGE LAYER (claims + skills) is then overlaid LIVE from its records — the same reindex-free path
  // assembleContext takes — because the screen's subject IS that layer: a claim a member wrote a minute ago belongs on
  // the map without waiting for an admin to rebuild the graph. Harvest ids are deterministic, so the overlay
  // reconciles with an already-reindexed projection instead of duplicating it.
  async graph(tenant: string, opts?: { depth?: number }): Promise<KnowledgeGraphResult> {
    const root = nodeId(tenant, { type: "workspace", key: tenant });
    const sub = await this.query.subgraph(tenant, root, { depth: opts?.depth ?? 2, direction: "both" });
    const nodes = new Map<string, KnowledgeNode>(sub.nodes.map((n) => [n.nodeId, n]));
    const edges = new Map<string, EdgeMention>(sub.edges.map((e) => [e.id, e]));

    const overlay = await this.knowledgeLayerOverlay(tenant);
    for (const n of overlay.nodes) nodes.set(n.nodeId, n);
    for (const e of overlay.edges) edges.set(e.id, e);
    // A pin whose entity has not been harvested yet has no node row, which would strand its claim as an orphan dot —
    // so materialise those endpoints as `dangling` reference nodes (the graph's record of a pending reference). The
    // map shows what a claim is ABOUT before the entity's own harvester ever runs.
    for (const node of overlay.references) if (!nodes.has(node.nodeId)) nodes.set(node.nodeId, node);

    const nodeList = [...nodes.values()];
    // Only edges whose BOTH endpoints are on the map: an edge to an unmaterialised node cannot be drawn and cannot
    // be listed as a relationship, so shipping it is pure weight. In practice this is the scoping star —
    // `in_workspace` to the (never-materialised) workspace hub and `created_by` to unharvested users — which was
    // ~460 of 990 edges on a 265-node workspace.
    const edgeList = [...edges.values()].flatMap((e) => {
      if (e.subjectNodeId === undefined || e.objectNodeId === undefined) return [];
      if (!nodes.has(e.subjectNodeId) || !nodes.has(e.objectNodeId)) return [];
      const edge: KnowledgeGraphEdge = {
        id: e.id,
        predicate: e.predicate,
        subjectNodeId: e.subjectNodeId,
        objectNodeId: e.objectNodeId,
        ...(e.subjectTypeHint !== undefined ? { subjectTypeHint: e.subjectTypeHint } : {}),
        ...(e.objectTypeHint !== undefined ? { objectTypeHint: e.objectTypeHint } : {}),
        polarity: e.polarity,
        edgeAttrs: e.edgeAttrs,
      };
      return [edge];
    });
    const nodesByType: Partial<Record<NodeType, number>> = {};
    for (const n of nodeList) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
    const edgesByPredicate: Partial<Record<Predicate, number>> = {};
    for (const e of edgeList) edgesByPredicate[e.predicate] = (edgesByPredicate[e.predicate] ?? 0) + 1;
    return {
      root,
      nodes: nodeList,
      edges: edgeList,
      stats: { totalNodes: nodeList.length, totalEdges: edgeList.length, nodesByType, edgesByPredicate },
    };
  }

  // The live projection of the workspace-visible knowledge-layer records, plus the reference endpoints their pins
  // point at. Same admission rule as reindex — workspace visibility only, and a `proposed` extraction candidate is
  // not workspace knowledge until someone reviews it — so the live map and the harvested one agree on membership.
  private async knowledgeLayerOverlay(
    tenant: string,
  ): Promise<{ nodes: KnowledgeNode[]; edges: EdgeMention[]; references: KnowledgeNode[] }> {
    const src = this.deps.contextSources ?? this.deps.reindexSources;
    const nodes: KnowledgeNode[] = [];
    const edges: EdgeMention[] = [];
    const references: KnowledgeNode[] = [];
    const reference = (ref: NodeRef, at: string): void => {
      references.push({
        nodeId: nodeId(tenant, ref),
        tenant,
        type: ref.type,
        key: ref.key,
        ...(ref.version !== undefined ? { version: ref.version } : {}),
        label: ref.version !== undefined ? `${ref.key}@${ref.version}` : ref.key,
        attrs: {},
        resolution: "dangling",
        evidenceCount: 0,
        createdAt: at,
        updatedAt: at,
      });
    };

    if (src?.skills) {
      for (const s of await src.skills.list(tenant, "")) {
        if (s.visibility !== "workspace") continue;
        const h = harvestSkill(s);
        nodes.push(...h.nodes);
        edges.push(...h.edges);
        for (const r of s.refs) reference(r, s.updatedAt);
      }
    }
    if (src?.knowledgeEntries) {
      for (const e of await src.knowledgeEntries.list(tenant, "")) {
        if (e.visibility !== "workspace" || e.status === "proposed") continue;
        const h = harvestKnowledgeEntry(e);
        nodes.push(...h.nodes);
        edges.push(...h.edges);
        for (const r of [...e.refs, ...e.evidence]) reference(r, e.updatedAt);
      }
    }
    return { nodes, edges, references };
  }

  // The authored notes on a node (the read side of `annotate`), newest first.
  notes(tenant: string, nodeId: string): Promise<Mention[]> {
    return this.deps.store.notesForNode(tenant, nodeId);
  }

  // Harvest the workspace's existing records + registry entities into the graph. Idempotent (the harvesters emit
  // deterministic ids), so a re-run reconciles rather than duplicates. Registry entities are harvested at their LATEST
  // version; the registration timestamp is unavailable uniformly, so the node's observation time is the reindex moment.
  //
  // Two passes: the intent stratum + config + knowledge layer go first and COLLECT every execution reference (issue
  // links/resolutions, knowledge refs/evidence, skill refs, capability origins); the execution records (runs/
  // scorecards) go last and are materialised only when referenced — then nodes whose reference went away are pruned.
  // See the admission rule on KnowledgeReindexSources.
  async reindex(tenant: string): Promise<KnowledgeReindexResult> {
    const src = this.deps.reindexSources;
    const stamp = new Date().toISOString();
    const acc: KnowledgeReindexResult = { scanned: 0, nodes: 0, edges: 0, pruned: 0 };
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

    // The execution nodes something admitted into the graph, by nodeId.
    const referencedExecution = new Set<string>();
    const referenceExecution = (type: "run" | "scorecard", key: string | undefined): void => {
      if (key !== undefined && key !== "") referencedExecution.add(nodeId(tenant, { type, key }));
    };
    const referencePins = (pins: { type: string; key: string }[]): void => {
      for (const p of pins) if (p.type === "run" || p.type === "scorecard") referenceExecution(p.type, p.key);
    };
    // Registry metadata for one entity's latest version: ownership + the version's origin stamp
    // (whose `from` may itself admit an execution record — a judge born from a scorecard keeps that scorecard on
    // the map). Entry shapes vary per registry; the fields are read structurally and absent ones simply skip.
    const specMeta = (
      entry: { createdBy?: string; versionOrigins?: Record<string, CapabilityOrigin> },
      version: string,
    ): SpecHarvestMeta => {
      const origin = entry.versionOrigins?.[version];
      const from = origin?.from;
      if (from !== undefined && (from.type === "run" || from.type === "scorecard"))
        referenceExecution(from.type, from.id);
      return {
        ...meta(entry.createdBy),
        ...(origin !== undefined ? { origin } : {}),
      };
    };

    // The intent stratum — the plan first, then the issues whose links
    // and resolutions are the graph's main execution-admission gate.
    if (src?.initiatives) for (const n of await src.initiatives.list(tenant)) await apply(harvestInitiative(n));
    if (src?.projects) for (const p of await src.projects.list(tenant)) await apply(harvestProject(p));
    if (src?.issues) {
      for (const i of await src.issues.list(tenant)) {
        await apply(harvestIssue(i));
        referencePins(i.links.map((l) => ({ type: l.type, key: l.id })));
        referenceExecution("scorecard", i.resolution?.scorecardId);
      }
    }

    // Schedules (config-cardinality, harvested whole).
    if (src?.schedules) for (const s of await src.schedules.list(tenant)) await apply(harvestSchedule(s));

    // Versioned registries — harvest each entity's latest version, with its origin registry metadata.
    if (src?.datasets) {
      for (const e of await src.datasets.list(tenant)) {
        const spec = await src.datasets.get(tenant, e.id);
        await apply(harvestDataset(specMeta(e, spec.version), spec));
      }
    }
    if (src?.judges) {
      for (const e of await src.judges.list(tenant)) {
        const spec = await src.judges.get(tenant, e.id);
        await apply(harvestJudge(specMeta(e, spec.version), spec));
      }
    }
    if (src?.runtimes) {
      for (const e of await src.runtimes.list(tenant)) {
        const spec = await src.runtimes.get(tenant, e.id);
        await apply(harvestRuntime(specMeta(e, spec.version), spec));
      }
    }
    if (src?.models) {
      for (const e of await src.models.list(tenant)) {
        const spec = await src.models.get(tenant, e.id);
        await apply(harvestModel(specMeta(e, spec.version), spec));
      }
    }
    if (src?.rubrics) {
      for (const e of await src.rubrics.list(tenant)) {
        const spec = await src.rubrics.get(tenant, e.id);
        await apply(harvestRubric(specMeta(e, spec.version), spec));
      }
    }
    if (src?.harnesses) {
      for (const e of await src.harnesses.list(tenant)) {
        const spec = await src.harnesses.get(tenant, e.id);
        await apply(harvestHarness(specMeta(e, spec.version), spec));
      }
    }
    if (src?.agents) {
      for (const e of await src.agents.list(tenant)) {
        const spec = await src.agents.get(tenant, e.id);
        await apply(harvestAgent(specMeta(e, spec.version), spec));
      }
    }

    // Knowledge-layer records — workspace-visible only (empty subject → no private drafts; belt-and-braces filter).
    // Their pins admit the execution records they cite as evidence.
    if (src?.skills) {
      for (const s of await src.skills.list(tenant, "")) {
        if (s.visibility !== "workspace") continue;
        await apply(harvestSkill(s));
        referencePins(s.refs);
      }
    }
    if (src?.knowledgeEntries) {
      // Proposed entries stay OUT of the graph — an unreviewed extraction candidate is not workspace knowledge yet.
      for (const e of await src.knowledgeEntries.list(tenant, "")) {
        if (e.visibility !== "workspace" || e.status === "proposed") continue;
        await apply(harvestKnowledgeEntry(e));
        referencePins([...e.refs, ...e.evidence]);
      }
    }

    // The execution stratum LAST — materialised only while referenced (evidence, not inventory).
    if (src?.scorecards) {
      for (const sc of await src.scorecards.list(tenant)) {
        if (referencedExecution.has(nodeId(tenant, { type: "scorecard", key: sc.id }))) {
          await apply(harvestScorecard(sc));
        }
      }
    }
    if (src?.runs) {
      for (const r of await src.runs.list(tenant, { includeChildren: true })) {
        if (referencedExecution.has(nodeId(tenant, { type: "run", key: r.id }))) await apply(harvestRun(r));
      }
    }

    // Prune execution nodes whose admission went away — per type, and only when that type's source is wired (a
    // partially-wired service must not retract projections another deployment owns). The mention/edge spine stays.
    const pruneTypes: NodeType[] = [];
    if (src?.scorecards) pruneTypes.push("scorecard");
    if (src?.runs) pruneTypes.push("run");
    if (pruneTypes.length > 0) {
      const existing = await this.deps.store.listNodeIds(tenant, pruneTypes);
      const stale = existing.filter((id) => !referencedExecution.has(id));
      if (stale.length > 0) await this.deps.store.deleteNodes(tenant, stale);
      acc.pruned = stale.length;
    }
    return acc;
  }

  // Task-time context assembly — the knowledge layer's consumption surface. For a set of anchors (the entities a
  // task concerns: @-references, the scorecard under discussion, a harness being edited), returns per-anchor ranked
  // structural facts (graph) + the knowledge entries and skill candidates ABOUT those anchors (records, family-matched
  // on (type, key) so a claim pinned at web-agent@2.1.0 still surfaces when the task anchors web-agent@2.3.0).
  //
  // AS-OF PROJECTION: the anchor's own version is the coordinate the knowledge base is projected onto — an
  // unversioned anchor resolves to the family's current latest (present-projection); an old scorecard's
  // harness@2.1.0 anchor projects onto that point. Each matched item carries its ANCHOR RELATION
  // (`covers | earlier | later | general`), and the ranking is relation > status > recency — at a past coordinate a
  // SUPERSEDED claim that covers it outranks an active claim pinned later (time is a coordinate, not decay).
  async assembleContext(tenant: string, subject: string, anchors: NodeRef[]): Promise<TaskContext> {
    const ctxSrc = this.deps.contextSources;
    const now = new Date().toISOString();
    const anchorLanes: TaskContextAnchor[] = [];
    for (const ref of anchors) {
      const id = nodeId(tenant, ref);
      anchorLanes.push({ ref, nodeId: id, facts: await this.query.relatedFacts(tenant, id, {}) });
    }

    // The projection coordinate per anchor family: the anchor's own version, else the family's current latest.
    const famKey = (r: NodeRef): string => `${r.type}:${r.key}`;
    const coordinates = new Map<string, string | undefined>();
    for (const a of anchors) {
      const coordinate = a.version ?? (await ctxSrc?.latestVersionOf?.(tenant, a));
      coordinates.set(famKey(a), coordinate);
    }
    const matches = (refs: NodeRef[]): boolean => refs.some((r) => coordinates.has(famKey(r)));

    // The strongest relation of a record's pins to the anchor coordinates. Priority mirrors the ranking: confirmed-
    // at-this-coordinate and timeless claims lead; earlier (validity here unknown) next; later (from this
    // coordinate's future — the "what happened next" trail) last.
    const RELATION_TIER: Record<AnchorRelation, number> = { covers: 0, general: 0, earlier: 1, later: 2 };
    const relationFor = (refs: KnowledgePin[]): AnchorRelation | undefined => {
      let best: AnchorRelation | undefined;
      for (const pin of refs) {
        if (!coordinates.has(famKey(pin))) continue; // not an anchor family
        const rel = anchorRelation(pin, coordinates.get(famKey(pin)));
        if (rel === undefined) continue; // unresolved coordinate — indeterminate, never penalized
        if (best === undefined || RELATION_TIER[rel] < RELATION_TIER[best]) best = rel;
      }
      return best;
    };
    const tier = (rel: AnchorRelation | undefined): number => (rel === undefined ? 0 : RELATION_TIER[rel]);
    const baseline = (r: { verifiedAt?: string; updatedAt: string }): string =>
      r.verifiedAt !== undefined && r.verifiedAt > r.updatedAt ? r.verifiedAt : r.updatedAt;

    let knowledge: TaskContext["knowledge"] = [];
    if (ctxSrc?.knowledgeEntries) {
      // Proposed (unreviewed) candidates never feed agent context — review first, then they count as knowledge.
      const matched = (await ctxSrc.knowledgeEntries.list(tenant, subject)).filter(
        (e) => e.status !== "proposed" && matches(e.refs),
      );
      const withRelation = matched.map((e) => ({ entry: e, relation: relationFor(e.refs) }));
      // relation > status > recency: a superseded claim that COVERS the anchor coordinate is that coordinate's
      // truth — it outranks an active claim from the coordinate's future. Status only breaks ties within a tier.
      withRelation.sort((a, b) => {
        const t = tier(a.relation) - tier(b.relation);
        if (t !== 0) return t;
        if (a.entry.status !== b.entry.status) return a.entry.status === "active" ? -1 : 1;
        return baseline(b.entry).localeCompare(baseline(a.entry));
      });
      const page = withRelation.slice(0, 20);
      const decorated = ctxSrc.latestVersionOf
        ? await resolveCoverage(
            tenant,
            page.map((p) => p.entry),
            ctxSrc.latestVersionOf,
            now,
          )
        : undefined;
      knowledge = page.map(({ entry, relation }, i) => {
        const c = decorated?.[i];
        return {
          ...entry,
          ...(relation !== undefined ? { relation } : {}),
          ...(c !== undefined ? { coverage: c } : {}),
        };
      });
    }

    let skills: TaskContextSkill[] = [];
    if (ctxSrc?.skills) {
      const matched = (await ctxSrc.skills.list(tenant, subject)).filter((s) => matches(s.refs));
      const withRelation = matched.map((s) => ({ record: s, relation: relationFor(s.refs) }));
      withRelation.sort((a, b) => tier(a.relation) - tier(b.relation));
      const page = withRelation.slice(0, 20);
      const decorated = ctxSrc.latestVersionOf
        ? await resolveCoverage(
            tenant,
            page.map((p) => p.record),
            ctxSrc.latestVersionOf,
            now,
          )
        : undefined;
      skills = page.map(({ record, relation }, i) => {
        const c = decorated?.[i];
        return {
          id: record.id,
          name: record.name,
          description: record.description,
          refs: record.refs,
          ...(c !== undefined ? { coverage: c } : {}),
          ...(relation !== undefined ? { relation } : {}),
        };
      });
    }

    return { anchors: anchorLanes, knowledge, skills };
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
