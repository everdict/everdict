import type {
  ChangeCampaignRecord,
  ChangeSetEntry,
  EvolutionCampaignRecord,
  KnowledgeEntryRecord,
} from "@everdict/contracts";
import { summariseAnswers } from "@everdict/domain";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { EvolutionCampaignStore } from "../ports/evolution-campaign-store.js";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";

// ── LINEAGE FROM THE REQUEST ─────────────────────────────────────────────────────────────────────────
//
// The edges already existed and did not JOIN: a campaign names its issue, an adoption names its issue, a
// knowledge entry pins whatever it is about. Answering "what did this request cause" meant three reads and a
// mental merge, which is the same as not being able to answer it.
//
// This is that one read. It composes rather than stores — a lineage derived from records is re-derivable; one
// materialised into a table is a second authority that can disagree with them.

export interface LineageChange extends ChangeSetEntry {
  campaignId: string;
  roundSeq: number;
}

export interface LineageCampaign {
  grade: "change" | "evaluated";
  id: string;
  state: string;
  // The change grade's own shape, absent on the evaluated one (whose subject is a capability, not a service).
  service?: { repository: string; path?: string };
  rounds: {
    seq: number;
    outcome: string;
    hypothesis?: string;
    answers?: ReturnType<typeof summariseAnswers>;
    changes?: ChangeSetEntry[];
  }[];
  // The chain: an evaluated campaign continues another, which is what makes a walk a tree rather than a list.
  continues?: string;
  closedAt?: string;
}

export interface LineageKnowledge {
  id: string;
  kind: string;
  title: string;
  status: string;
  // HOW it is reachable from the request — pinned to the issue itself, or to one of its campaigns. Two
  // different claims: the second only became expressible when `campaign` joined the reference vocabulary.
  via: "issue" | "campaign";
  campaignId?: string;
}

// WHAT COULD NOT BE READ, per source. A lineage assembled from optional collaborators must not let "this
// deployment has no evolution campaigns wired" look like "this request had none" (rule `protocol` L2).
export type LineageSourceState = "read" | "unavailable";

export interface IssueLineage {
  issueId: string;
  campaigns: LineageCampaign[];
  changes: LineageChange[];
  knowledge: LineageKnowledge[];
  sources: {
    changeCampaigns: LineageSourceState;
    evaluatedCampaigns: LineageSourceState;
    knowledge: LineageSourceState;
  };
}

export interface IssueLineageDeps {
  changeCampaigns?: Pick<ChangeCampaignStore, "list">;
  evolutionCampaigns?: Pick<EvolutionCampaignStore, "list">;
  knowledgeEntries?: Pick<KnowledgeEntryStore, "list">;
}

const changeCampaignToLineage = (c: ChangeCampaignRecord): LineageCampaign => ({
  grade: "change",
  id: c.id,
  state: c.state,
  service: c.service,
  rounds: c.rounds.map((r) => ({
    seq: r.seq,
    outcome: r.outcome,
    hypothesis: r.hypothesis,
    answers: summariseAnswers(r.judgement.answers),
    changes: r.changes,
  })),
  ...(c.close ? { closedAt: c.close.at } : {}),
});

const evolutionCampaignToLineage = (c: EvolutionCampaignRecord): LineageCampaign => ({
  grade: "evaluated",
  id: c.id,
  state: c.state,
  rounds: c.rounds.map((r) => ({ seq: r.seq, outcome: r.verdict.comparable ? "judged" : "not_comparable" })),
  ...(c.frame.continues !== undefined ? { continues: c.frame.continues } : {}),
  ...(c.close ? { closedAt: c.close.at } : {}),
});

export class IssueLineageService {
  constructor(private readonly deps: IssueLineageDeps) {}

  async assemble(tenant: string, subject: string, issueId: string): Promise<IssueLineage> {
    const campaigns: LineageCampaign[] = [];
    const changes: LineageChange[] = [];

    const changeStore = this.deps.changeCampaigns;
    if (changeStore) {
      for (const c of await changeStore.list(tenant, { issueId })) {
        campaigns.push(changeCampaignToLineage(c));
        for (const round of c.rounds)
          for (const entry of round.changes) changes.push({ ...entry, campaignId: c.id, roundSeq: round.seq });
      }
    }

    const evolutionStore = this.deps.evolutionCampaigns;
    const evaluated = evolutionStore
      ? // The evolution store lists by SUBJECT, not by issue, so the filter happens here. Honest and O(n) —
        // worth replacing with an indexed read when a workspace's campaign count makes it matter, not before.
        (await evolutionStore.list(tenant)).filter((c) => c.issueId === issueId)
      : [];
    for (const c of evaluated) campaigns.push(evolutionCampaignToLineage(c));

    const knowledgeStore = this.deps.knowledgeEntries;
    const knowledge: LineageKnowledge[] = [];
    if (knowledgeStore) {
      const campaignIds = new Set(campaigns.map((c) => c.id));
      for (const entry of await knowledgeStore.list(tenant, subject)) {
        const via = reachFrom(entry, issueId, campaignIds);
        if (via) knowledge.push({ id: entry.id, kind: entry.kind, title: entry.title, status: entry.status, ...via });
      }
    }

    return {
      issueId,
      campaigns,
      changes,
      knowledge,
      sources: {
        changeCampaigns: changeStore ? "read" : "unavailable",
        evaluatedCampaigns: evolutionStore ? "read" : "unavailable",
        knowledge: knowledgeStore ? "read" : "unavailable",
      },
    };
  }
}

// An entry is reachable from the request directly, or through a campaign the request caused. The campaign
// edge is the one that only became expressible when `campaign` joined `NODE_TYPES` — before it, what an
// attempt TAUGHT could be found only if someone had also pinned the issue.
function reachFrom(
  entry: KnowledgeEntryRecord,
  issueId: string,
  campaignIds: Set<string>,
): { via: LineageKnowledge["via"]; campaignId?: string } | undefined {
  for (const ref of entry.refs) if (ref.type === "issue" && ref.key === issueId) return { via: "issue" };
  for (const ref of entry.refs)
    if (ref.type === "campaign" && campaignIds.has(ref.key)) return { via: "campaign", campaignId: ref.key };
  return undefined;
}
