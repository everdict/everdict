import type {
  ChangeCampaignRecord,
  ChangeSetEntry,
  EvolutionCampaignRecord,
  KnowledgeEntryRecord,
} from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";
import { summariseAnswers } from "@everdict/domain";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { EvolutionCampaignStore } from "../ports/evolution-campaign-store.js";
import type { IssueRefResolver } from "../ports/issue-ref-resolver.js";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";

// ── LINEAGE FROM THE REQUEST ─────────────────────────────────────────────────────────────────────────
//
// The edges already existed and did not JOIN: a campaign names its issue, an adoption names its issue, a
// knowledge entry pins whatever it is about. Answering "what did this request cause" meant three reads and a
// mental merge, which is the same as not being able to answer it.
//
// This is that one read. It composes rather than stores — a lineage derived from records is re-derivable; one
// materialised into a table is a second authority that can disagree with them.
//
// ── AND SEVERAL STEPS BACK ───────────────────────────────────────────────────────────────────────────
//
// The first version answered exactly one hop and stopped, which answers "what did this cause" and not "how
// did it come to be". The edges for the second question were all stored and none were followed: a campaign
// `continues` the one whose remainder it picked up, and a knowledge entry `supersedes` the claim it corrected.
// The evaluated grade even EMITTED its chain — with a comment saying it "is what makes a walk a tree rather
// than a list" — and nothing walked it, while the web rendered it as a link a person could click. So a human
// could chase the history by hand and an agent calling the same capability could not.
//
// `depth` is the caller's, because how far back is worth reading depends on the question, and a fixed walk is
// either too shallow for a retraction chain or too expensive for a glance. Depth 1 is the request's own
// records — the original answer, unchanged, so no existing caller moved.
export const LINEAGE_DEFAULT_DEPTH = 1;
export const LINEAGE_MAX_DEPTH = 5;

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
  // The chain: a campaign continues another, which is what makes a walk a tree rather than a list. Emitted by
  // BOTH grades — the change grade stored it from the start and only the evaluated one reported it, so half
  // the chains in this workspace were invisible to every reader.
  continues?: string;
  closedAt?: string;
  // WHICH HOP REACHED IT. 1 = it names the request itself; n = n-1 `continues` steps back from one that does.
  depth: number;
}

export interface LineageKnowledge {
  id: string;
  kind: string;
  title: string;
  status: string;
  // HOW it is reachable from the request — BOTH ways, not the first one found. An entry that pins the issue
  // AND the campaign is reachable twice, and an earlier version of this returned only "issue" for it: since
  // the plugin's own skill tells every session to pin the issue, the campaign edge would have been invisible
  // exactly when it existed. Found by exercising the read against a deployment, never by a unit test that
  // pinned one ref at a time. `supersededBy` is the third way in, and the one the walk added: an entry nobody
  // pinned to this request is still part of its history when the request's own entry replaced it.
  reachedBy: { issue: boolean; campaigns: string[]; supersededBy?: string };
  // The claim this one corrected, when it names one — carried so a reader can see the chain continues past
  // the depth they asked for rather than inferring that it ended.
  supersedes?: string;
  depth: number;
}

// WHAT COULD NOT BE READ, per source. A lineage assembled from optional collaborators must not let "this
// deployment has no evolution campaigns wired" look like "this request had none" (rule `protocol` L2).
export type LineageSourceState = "read" | "unavailable";

// ── WHAT THE WALK DID, AS A VALUE ────────────────────────────────────────────────────────────────────
//
// A bounded traversal that does not say it was bounded reports "there is no more" when it means "I stopped",
// which is the same defect one level down from `sources` and the reason that field exists. So the three ways
// a walk ends short are each a COUNT a caller can act on, never an absence it has to infer:
//
//   truncated   a chain still had a next step when the depth ran out → ask again with more depth
//   cycles      a chain pointed back at something already visited → a defect in the RECORDS, not the walk
//   unresolved  a chain named a record this read could not fetch → "cannot find out", never "there is none"
export interface LineageWalk {
  requested: number;
  // The greatest depth actually populated — 1 when nothing chained, which is how a caller tells "I asked for
  // 5 and the history is one hop deep" from "I asked for 5 and hit the ceiling".
  reached: number;
  truncated: boolean;
  cycles: number;
  unresolved: number;
}

export interface IssueLineage {
  issueId: string;
  campaigns: LineageCampaign[];
  changes: LineageChange[];
  knowledge: LineageKnowledge[];
  walk: LineageWalk;
  sources: {
    changeCampaigns: LineageSourceState;
    evaluatedCampaigns: LineageSourceState;
    knowledge: LineageSourceState;
  };
}

export interface IssueLineageDeps {
  // `get` is what makes the chain walkable: `list` is filtered to the request, and a campaign this one
  // continues belongs to whatever request came before it.
  changeCampaigns?: Pick<ChangeCampaignStore, "list" | "get">;
  evolutionCampaigns?: Pick<EvolutionCampaignStore, "list">;
  knowledgeEntries?: Pick<KnowledgeEntryStore, "list">;
  // ── THE REF IS RESOLVED BEFORE ANYTHING IS LOOKED UP (DEFAUL-53) ────────────────────────────────────
  //
  // REQUIRED, unlike the three stores above, and the difference is deliberate. A missing STORE is a source
  // this deployment does not have, and the read says so (`sources`). A missing RESOLVER is not a smaller
  // answer — it is the same answer computed against the wrong key, and it comes back looking correct.
  //
  // Measured: `get_issue_lineage { id: "DEFAUL-37" }` returned `{campaigns: [], changes: [], knowledge: []}`
  // with every source reporting `read`, for a request that had an adopted campaign, a round, two commits and
  // a decision entry. Campaigns are filed under the uuid because `ChangeCampaignService.open` resolves the
  // ref before storing — and the comment there names this exact failure: "the lineage read (which asks by id)
  // simply does not find the ones typed the other way". The write side learned it; this read had not.
  issues: IssueRefResolver;
}

export interface AssembleLineageOptions {
  depth?: number;
}

const changeCampaignToLineage = (c: ChangeCampaignRecord, depth: number): LineageCampaign => ({
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
  ...(c.continues !== undefined ? { continues: c.continues } : {}),
  ...(c.close ? { closedAt: c.close.at } : {}),
  depth,
});

const evolutionCampaignToLineage = (c: EvolutionCampaignRecord, depth: number): LineageCampaign => ({
  grade: "evaluated",
  id: c.id,
  state: c.state,
  rounds: c.rounds.map((r) => ({ seq: r.seq, outcome: r.verdict.comparable ? "judged" : "not_comparable" })),
  ...(c.frame.continues !== undefined ? { continues: c.frame.continues } : {}),
  ...(c.close ? { closedAt: c.close.at } : {}),
  depth,
});

export class IssueLineageService {
  constructor(private readonly deps: IssueLineageDeps) {}

  async assemble(
    tenant: string,
    subject: string,
    ref: string,
    options?: AssembleLineageOptions,
  ): Promise<IssueLineage> {
    // Whichever spelling the caller used, the key every source is filed under is the id the resolution
    // produced. A ref the workspace does not have THROWS here (NotFoundError) rather than walking on to
    // answer an empty lineage: "there is no such issue" and "this request caused nothing" are different
    // facts, and only one of them is news.
    const issueId = (await this.deps.issues.get(tenant, ref)).id;
    const depth = resolveDepth(options?.depth);
    const walk = { requested: depth, reached: 1, truncated: false, cycles: 0, unresolved: 0 };
    const deepen = (d: number) => {
      if (d > walk.reached) walk.reached = d;
    };

    const campaigns: LineageCampaign[] = [];
    const changes: LineageChange[] = [];
    // campaign id → the hop that reached it, so an entry pinned to an ANCESTOR campaign inherits that
    // campaign's distance instead of looking as close to the request as the request's own work.
    const campaignDepth = new Map<string, number>();

    const changeStore = this.deps.changeCampaigns;
    if (changeStore) {
      let frontier = await changeStore.list(tenant, { issueId });
      for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next: ChangeCampaignRecord[] = [];
        for (const c of frontier) {
          if (campaignDepth.has(c.id)) {
            walk.cycles += 1;
            continue;
          }
          campaignDepth.set(c.id, d);
          campaigns.push(changeCampaignToLineage(c, d));
          deepen(d);
          for (const round of c.rounds)
            for (const entry of round.changes) changes.push({ ...entry, campaignId: c.id, roundSeq: round.seq });

          const previous = c.continues;
          if (previous === undefined) continue;
          if (d === depth) {
            walk.truncated = true;
            continue;
          }
          if (campaignDepth.has(previous)) {
            walk.cycles += 1;
            continue;
          }
          const record = await changeStore.get(tenant, previous);
          if (record === undefined) {
            walk.unresolved += 1;
            continue;
          }
          next.push(record);
        }
        frontier = next;
      }
    }

    const evolutionStore = this.deps.evolutionCampaigns;
    if (evolutionStore) {
      // The evolution store lists by SUBJECT, not by issue, so the filter happens here. Honest and O(n) —
      // worth replacing with an indexed read when a workspace's campaign count makes it matter, not before.
      // The same list is what the chain walks: the predecessor is already in memory, so following it costs
      // nothing beyond the lookup.
      const all = await evolutionStore.list(tenant);
      const byId = new Map(all.map((c) => [c.id, c]));
      let frontier = all.filter((c) => c.issueId === issueId);
      for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next: EvolutionCampaignRecord[] = [];
        for (const c of frontier) {
          if (campaignDepth.has(c.id)) {
            walk.cycles += 1;
            continue;
          }
          campaignDepth.set(c.id, d);
          campaigns.push(evolutionCampaignToLineage(c, d));
          deepen(d);

          const previous = c.frame.continues;
          if (previous === undefined) continue;
          if (d === depth) {
            walk.truncated = true;
            continue;
          }
          if (campaignDepth.has(previous)) {
            walk.cycles += 1;
            continue;
          }
          const record = byId.get(previous);
          if (record === undefined) {
            walk.unresolved += 1;
            continue;
          }
          next.push(record);
        }
        frontier = next;
      }
    }

    const knowledgeStore = this.deps.knowledgeEntries;
    const knowledge: LineageKnowledge[] = [];
    if (knowledgeStore) {
      const entries = await knowledgeStore.list(tenant, subject);
      const byId = new Map(entries.map((e) => [e.id, e]));
      const placed = new Map<string, number>();

      let frontier: { entry: KnowledgeEntryRecord; depth: number }[] = [];
      for (const entry of entries) {
        const reachedBy = reachFrom(entry, issueId, campaignDepth);
        if (!reachedBy.issue && reachedBy.campaigns.length === 0) continue;
        // Directly pinned to the request is hop 1; reached only through a campaign is that campaign's hop.
        const d = reachedBy.issue ? 1 : Math.min(...reachedBy.campaigns.map((id) => campaignDepth.get(id) ?? 1));
        placed.set(entry.id, d);
        knowledge.push({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          status: entry.status,
          reachedBy,
          ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
          depth: d,
        });
        deepen(d);
        frontier.push({ entry, depth: d });
      }

      while (frontier.length > 0) {
        const next: { entry: KnowledgeEntryRecord; depth: number }[] = [];
        for (const node of frontier) {
          const previous = node.entry.supersedes;
          if (previous === undefined) continue;
          if (node.depth === depth) {
            walk.truncated = true;
            continue;
          }
          if (placed.has(previous)) {
            walk.cycles += 1;
            continue;
          }
          const ancestor = byId.get(previous);
          if (ancestor === undefined) {
            // The claim this one corrected is not readable here — deleted, or not visible to this subject.
            // Counting it is the difference between "the chain ends" and "the chain continues out of sight".
            walk.unresolved += 1;
            continue;
          }
          const d = node.depth + 1;
          placed.set(ancestor.id, d);
          knowledge.push({
            id: ancestor.id,
            kind: ancestor.kind,
            title: ancestor.title,
            status: ancestor.status,
            // An ancestor is reached BECAUSE something replaced it; it need not pin this request at all.
            reachedBy: { issue: false, campaigns: [], supersededBy: node.entry.id },
            ...(ancestor.supersedes !== undefined ? { supersedes: ancestor.supersedes } : {}),
            depth: d,
          });
          deepen(d);
          next.push({ entry: ancestor, depth: d });
        }
        frontier = next;
      }
    }

    campaigns.sort((a, b) => a.depth - b.depth);
    knowledge.sort((a, b) => a.depth - b.depth);

    return {
      issueId,
      campaigns,
      changes,
      knowledge,
      walk,
      sources: {
        changeCampaigns: changeStore ? "read" : "unavailable",
        evaluatedCampaigns: evolutionStore ? "read" : "unavailable",
        knowledge: knowledgeStore ? "read" : "unavailable",
      },
    };
  }
}

// A depth the caller did not state is the original one-hop read, and a depth outside the range is REFUSED
// rather than clamped: silently serving 5 to someone who asked for 50 answers a question they did not ask.
function resolveDepth(requested: number | undefined): number {
  if (requested === undefined) return LINEAGE_DEFAULT_DEPTH;
  if (!Number.isInteger(requested) || requested < 1 || requested > LINEAGE_MAX_DEPTH)
    throw new BadRequestError(
      "BAD_REQUEST",
      { depth: requested, max: LINEAGE_MAX_DEPTH },
      `depth must be an integer between 1 and ${LINEAGE_MAX_DEPTH} — 1 is the request's own records, each step beyond it follows one \`continues\` or \`supersedes\` edge`,
    );
  return requested;
}

// An entry is reachable from the request directly, through a campaign the request caused, or both. The
// campaign edge only became expressible when `campaign` joined `NODE_TYPES` — and it is only VISIBLE because
// this returns every way in rather than the first.
function reachFrom(
  entry: KnowledgeEntryRecord,
  issueId: string,
  campaignDepth: Map<string, number>,
): LineageKnowledge["reachedBy"] {
  return {
    issue: entry.refs.some((ref) => ref.type === "issue" && ref.key === issueId),
    campaigns: entry.refs.filter((ref) => ref.type === "campaign" && campaignDepth.has(ref.key)).map((ref) => ref.key),
  };
}
