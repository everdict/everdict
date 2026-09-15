import type { KnowledgeEntryRecord, KnowledgePin, NodeRef } from "@everdict/contracts";
import { type AnchorRelation, type Coverage, anchorRelation } from "@everdict/domain";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import type { SkillStore } from "../ports/skill-store.js";
import { type LatestVersionResolver, resolveCoverage } from "./freshness-resolver.js";

// What task-time context assembly reads: the knowledge-entry and skill RECORDS themselves (always current — there is
// no projection to wait for), plus the latest-version resolver that places each anchor on its family's timeline and
// decorates every matched item with its coverage against the present. Without a resolver an unversioned anchor has no
// coordinate (its matches carry no relation) and no item is coverage-decorated.
export interface KnowledgeServiceDeps {
  skills: Pick<SkillStore, "list">;
  knowledgeEntries: Pick<KnowledgeEntryStore, "list">;
  latestVersionOf?: LatestVersionResolver;
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

// assembleContext's result — the one payload that feeds the in-product agent, spawned subagents, and Claude Code via
// the plugin (MCP get_task_context): the workspace's knowledge entries and skill candidates ABOUT the anchors. Each item
// carries its ANCHOR RELATION — where its known-valid interval sits relative to the anchor coordinate
// (`covers | earlier | later | general`): the anchor's own version IS the as-of coordinate (pass an old scorecard's
// harness@2.1.0 and the knowledge base is projected onto that point; an unversioned anchor projects onto the present).
// See docs/architecture/workspace-knowledge.md §Task-context assembly.
export interface TaskContext {
  knowledge: (KnowledgeEntryRecord & { coverage?: Coverage; relation?: AnchorRelation })[];
  skills: TaskContextSkill[];
}

// The most entries and the most skill candidates one context carries.
const CONTEXT_PAGE = 20;

// The control-plane service behind task-time context assembly — the consumption surface of the workspace's knowledge.
// Both transports (POST /knowledge/context + MCP get_task_context) call this one service.
export class KnowledgeService {
  constructor(private readonly deps: KnowledgeServiceDeps) {}

  // For a set of anchors (the entities a task concerns: @-references, the scorecard under discussion, a harness being
  // edited), returns the knowledge entries and skill candidates ABOUT those anchors — family-matched on (type, key), so
  // a claim pinned at web-agent@2.1.0 still surfaces when the task anchors web-agent@2.3.0.
  //
  // AS-OF PROJECTION: the anchor's own version is the coordinate the knowledge base is projected onto — an
  // unversioned anchor resolves to the family's current latest (present-projection); an old scorecard's
  // harness@2.1.0 anchor projects onto that point. Each matched item carries its ANCHOR RELATION
  // (`covers | earlier | later | general`), and the ranking is relation > status > recency — at a past coordinate a
  // SUPERSEDED claim that covers it outranks an active claim pinned later (time is a coordinate, not decay).
  async assembleContext(tenant: string, subject: string, anchors: NodeRef[]): Promise<TaskContext> {
    const { skills: skillStore, knowledgeEntries, latestVersionOf } = this.deps;
    const now = new Date().toISOString();

    // The projection coordinate per anchor family: the anchor's own version, else the family's current latest.
    const famKey = (r: NodeRef): string => `${r.type}:${r.key}`;
    const coordinates = new Map<string, string | undefined>();
    for (const a of anchors) {
      const coordinate = a.version ?? (await latestVersionOf?.(tenant, a));
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

    // Proposed (unreviewed) candidates never feed agent context — review first, then they count as knowledge.
    const matchedEntries = (await knowledgeEntries.list(tenant, subject)).filter(
      (e) => e.status !== "proposed" && matches(e.refs),
    );
    const entriesWithRelation = matchedEntries.map((e) => ({ entry: e, relation: relationFor(e.refs) }));
    // relation > status > recency: a superseded claim that COVERS the anchor coordinate is that coordinate's
    // truth — it outranks an active claim from the coordinate's future. Status only breaks ties within a tier.
    entriesWithRelation.sort((a, b) => {
      const t = tier(a.relation) - tier(b.relation);
      if (t !== 0) return t;
      if (a.entry.status !== b.entry.status) return a.entry.status === "active" ? -1 : 1;
      return baseline(b.entry).localeCompare(baseline(a.entry));
    });
    const entryPage = entriesWithRelation.slice(0, CONTEXT_PAGE);
    const entryCoverage = latestVersionOf
      ? await resolveCoverage(
          tenant,
          entryPage.map((p) => p.entry),
          latestVersionOf,
          now,
        )
      : undefined;
    const knowledge: TaskContext["knowledge"] = entryPage.map(({ entry, relation }, i) => {
      const c = entryCoverage?.[i];
      return {
        ...entry,
        ...(relation !== undefined ? { relation } : {}),
        ...(c !== undefined ? { coverage: c } : {}),
      };
    });

    const matchedSkills = (await skillStore.list(tenant, subject)).filter((s) => matches(s.refs));
    const skillsWithRelation = matchedSkills.map((s) => ({ record: s, relation: relationFor(s.refs) }));
    skillsWithRelation.sort((a, b) => tier(a.relation) - tier(b.relation));
    const skillPage = skillsWithRelation.slice(0, CONTEXT_PAGE);
    const skillCoverage = latestVersionOf
      ? await resolveCoverage(
          tenant,
          skillPage.map((p) => p.record),
          latestVersionOf,
          now,
        )
      : undefined;
    const skills: TaskContextSkill[] = skillPage.map(({ record, relation }, i) => {
      const c = skillCoverage?.[i];
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        refs: record.refs,
        ...(c !== undefined ? { coverage: c } : {}),
        ...(relation !== undefined ? { relation } : {}),
      };
    });

    return { knowledge, skills };
  }
}
