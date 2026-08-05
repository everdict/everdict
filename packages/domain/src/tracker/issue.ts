import type {
  IssueGithub,
  IssueGithubComment,
  IssueGithubSync,
  IssueGroupBy,
  IssueLink,
  IssueLinkType,
  IssueOrder,
  IssuePriority,
  IssueRecord,
  IssueResolution,
  IssueStatus,
  IssueStatusCategory,
  IssueStatusCause,
  IssueSummary,
  PlatformFact,
} from "@everdict/contracts";
import {
  BadRequestError,
  ConflictError,
  ISSUE_GITHUB_COMMENT_LIMIT,
  ISSUE_PRIORITIES,
  ISSUE_STATUS_CATEGORY,
  NotFoundError,
} from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Issue aggregate — the tracker's unit of intent (docs/tracker.md). Transitions return {patch, facts} (E0,
// the same shape as Run/ScorecardBatch/Approval): the facts are born where the legality of the move is decided,
// and the store persists both in one transaction. Transitions must never be spread — always use .patch.
export interface IssueTransition {
  patch: Partial<IssueRecord>;
  facts: PlatformFact[];
}

export interface NewIssueLinkInput {
  type: IssueLinkType;
  id: string;
  version?: string;
  note?: string;
}

export interface NewIssueInput {
  id: string;
  tenant: string;
  // The owning team plus the identity it minted. The caller (IssueService) resolves the team — explicit or the
  // workspace default — and allocates the number from that team's counter, so the aggregate only records what
  // was decided rather than reaching for a store.
  teamId: string;
  number: number;
  identifier: string;
  title: string;
  description?: string;
  // Import maps a remote state onto our vocabulary (open → todo, closed → done); a member-filed issue starts in
  // the backlog unless they said otherwise.
  status?: IssueStatus;
  priority?: IssuePriority;
  estimate?: number;
  dueDate?: string;
  parentId?: string;
  cycleId?: string;
  milestoneId?: string;
  stateId?: string;
  inTriage?: boolean;
  projectId?: string;
  assignee?: string;
  // Registry ids, already resolved by the caller — the aggregate is pure, so name→id resolution (and the
  // auto-create a GitHub import needs) belongs to the service that owns the label store.
  labelIds?: string[];
  links?: NewIssueLinkInput[];
  resolution?: IssueResolution;
  github?: IssueGithub;
  createdBy: string;
  origin?: { agentId?: string; conversationId?: string };
  now: string;
}

export interface IssueEditInput {
  title?: string;
  description?: string | null;
  labelIds?: string[];
  assignee?: string | null;
  projectId?: string | null;
  priority?: IssuePriority;
  // `null` clears them: no estimate, no due date, no parent (the issue becomes top-level again).
  estimate?: number | null;
  dueDate?: string | null;
  parentId?: string | null;
  // Pulling an issue into an iteration (or out of one) is a plan change, not a workflow transition — it rides
  // the ordinary edit and leaves one `updated` history entry.
  cycleId?: string | null;
  // The project checkpoint. `null` detaches it.
  milestoneId?: string | null;
}

// A team move carries the destination AND the identity that team minted for the issue — the same pairing
// creation uses, because the aggregate must never reach for a store to learn its own name.
export interface IssueMoveInput {
  teamId: string;
  number: number;
  identifier: string;
  // Whether the destination team is on the issue's project. The SERVICE answers it (it holds the project
  // store); the aggregate decides what a "no" means — see `moveToTeam`. Absent = the issue is in no project,
  // or projects are not composed in this deployment, and there is nothing to decide.
  projectHoldsTeam?: boolean;
}

export interface IssueStatusChangeOptions {
  cause?: IssueStatusCause;
  // The team state the issue landed in, when the caller moved it by board column rather than by canonical
  // status. The status is still what everything programmatic reads; this records which column that was.
  stateId?: string;
  scorecardId?: string;
  note?: string;
}

export interface IssueReopenInput {
  // Default "todo" (a member picking work back up). The regression watch passes "regressed", which reads as an
  // alarm in every list instead of quietly looking like fresh work.
  to?: IssueStatus;
  cause: IssueStatusCause;
  scorecardId?: string;
  note?: string;
}

// Sort order for a list, and the ONE place the priority vocabulary turns into an ordering. `none` ranks LAST
// rather than first — an unprioritised issue is not the most urgent thing in the workspace, which is exactly
// the trap Linear's `priority = 0` encoding sets for anyone who sorts numerically without knowing the rule.
const PRIORITY_RANK: Record<IssuePriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function issuePriorityRank(priority: IssuePriority): number {
  return PRIORITY_RANK[priority];
}

// The vocabulary IN rank order — most urgent first, unprioritised last. Derived from the ranking above rather
// than typed out again, because a second list is a second place to forget where `none` belongs. Postgres sorts
// a priority-ordered page by looking a value up in exactly this array.
export const ISSUE_PRIORITIES_BY_RANK: readonly IssuePriority[] = [...ISSUE_PRIORITIES].sort(
  (a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b],
);

// OPEN = not done and not cancelled. `regressed` is deliberately open: a resolution that stopped holding is
// unfinished work, and the initiative readiness must treat it exactly like an unstarted issue.
// The closed half is `CLOSED_ISSUE_STATUSES` in the contracts, shared with the stores' aggregate counts — the
// SQL that counts open issues per team passes that same array, so the two readings cannot drift apart.
// The category IS the judgment: a status is open unless its category is completed or canceled. Derived rather
// than listed, so a state a team renames (or adds) can never change what "open" means — and `regressed`, whose
// category is `started`, keeps blocking a release exactly like unstarted work.
export function issueStatusCategory(status: IssueStatus): IssueStatusCategory {
  return ISSUE_STATUS_CATEGORY[status];
}

export function isOpenIssueStatus(status: IssueStatus): boolean {
  const category = ISSUE_STATUS_CATEGORY[status];
  return category !== "completed" && category !== "canceled";
}

function isTerminal(status: IssueStatus): boolean {
  return !isOpenIssueStatus(status);
}

// Record → LIST projection (docs/tracker.md). A pure narrowing, so it lives in the kernel and every holder of a
// whole record answers the list question identically — the in-memory store, the test fakes, anything that has
// records rather than rows. The Postgres store does NOT go through here: it projects in SQL, so the columns
// this function would drop are never read. Both must agree, and `IssueSummarySchema` is what says how.
export function issueSummaryOf(record: IssueRecord): IssueSummary {
  return {
    id: record.id,
    tenant: record.tenant,
    teamId: record.teamId,
    number: record.number,
    identifier: record.identifier,
    title: record.title,
    status: record.status,
    priority: record.priority,
    ...(record.estimate !== undefined ? { estimate: record.estimate } : {}),
    ...(record.dueDate !== undefined ? { dueDate: record.dueDate } : {}),
    ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
    ...(record.cycleId !== undefined ? { cycleId: record.cycleId } : {}),
    ...(record.milestoneId !== undefined ? { milestoneId: record.milestoneId } : {}),
    ...(record.stateId !== undefined ? { stateId: record.stateId } : {}),
    inTriage: record.inTriage,
    ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
    ...(record.assignee !== undefined ? { assignee: record.assignee } : {}),
    labelIds: record.labelIds,
    linkCount: record.links.length,
    ...(record.resolution !== undefined ? { resolution: record.resolution } : {}),
    ...(record.github !== undefined
      ? {
          github: {
            ...(record.github.host !== undefined ? { host: record.github.host } : {}),
            repository: record.github.repository,
            pull: record.github.sync.pull,
          },
        }
      : {}),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// --- Grouping and ordering: the semantics both store implementations mirror ---
// A grouped, sorted list is drawn from two sources that must agree — the aggregate that counts each group and
// the page that fills it — and on Postgres those are SQL while in memory they are these functions. Keeping the
// rules here (one group key, one sort key) is what stops the two readings from drifting: the SQL below each
// store method is written to produce exactly what these return.

// Which group a record falls in. `null` is the UNSET bucket — an issue with no assignee is not missing from
// the list, it belongs to the group every board draws at the end.
export function issueGroupKey(record: IssueRecord, groupBy: IssueGroupBy): string | null {
  switch (groupBy) {
    case "status":
      return record.status;
    case "priority":
      return record.priority;
    case "assignee":
      return record.assignee ?? null;
    case "project":
      return record.projectId ?? null;
    case "cycle":
      return record.cycleId ?? null;
  }
}

// Largest group first, ties by key so the sequence is stable across calls; the unset bucket sorts last
// whatever its size, because "nobody" is not a peer of the named groups. Exported because Postgres counts with
// a GROUP BY but orders through here — one ordering rule, so both implementations return the same sequence.
export function orderIssueGroupCounts(
  counts: readonly { key: string | null; count: number }[],
): { key: string | null; count: number }[] {
  return [...counts].sort((a, b) => {
    if (a.key === null) return b.key === null ? 0 : 1;
    if (b.key === null) return -1;
    return b.count - a.count || a.key.localeCompare(b.key);
  });
}

// Counts per group over records already in hand — the in-memory half of `IssueStore.countByGroup`.
export function issueCountsByGroup(
  records: readonly IssueRecord[],
  groupBy: IssueGroupBy,
): { key: string | null; count: number }[] {
  const counts = new Map<string, { key: string | null; count: number }>();
  for (const record of records) {
    const key = issueGroupKey(record, groupBy);
    // The map key spells the null bucket, because `Map` would happily keep `null` and the string "null" apart
    // only until a project is literally named that.
    const slot = key === null ? "unset:" : `key:${key}`;
    const entry = counts.get(slot) ?? { key, count: 0 };
    entry.count += 1;
    counts.set(slot, entry);
  }
  return orderIssueGroupCounts([...counts.values()]);
}

// The PRIMARY sort key, rendered as a string that sorts DESCENDING into the order the reader asked for. One
// comparable type for every ordering is what lets a single page cursor carry it: the token holds this value
// plus (updatedAt, id), and both stores resume from the same row.
//
// The two ASCENDING orderings are inverted here rather than at the comparison, because a cursor predicate that
// flips direction per ordering is a predicate somebody eventually gets backwards. `priority` inverts by
// subtracting the rank from the vocabulary size (urgent = highest); `due` inverts by complementing each digit
// of the date, so the earliest deadline compares greatest and an issue with NO deadline sorts last.
// Everything an ordering reads, and nothing else — so the LIST PROJECTION satisfies it too. The Postgres store
// mints its page token from the summary row it just selected; typing this as the whole record would have
// forced it to re-read columns the projection exists to avoid.
export type IssueOrderable = Pick<IssueRecord, "id" | "updatedAt" | "createdAt" | "priority" | "dueDate">;

export function issueOrderKey(record: IssueOrderable, order: IssueOrder): string {
  switch (order) {
    case "updated":
      return record.updatedAt;
    case "created":
      return record.createdAt;
    case "priority":
      // Zero-padded so the comparison stays a STRING comparison: unpadded, a tenth priority would rank "10"
      // below "2" and the ordering would quietly invert for the tail of the vocabulary.
      return String(ISSUE_PRIORITIES.length - issuePriorityRank(record.priority)).padStart(2, "0");
    case "due":
      return record.dueDate === undefined ? "0000-00-00" : complementDate(record.dueDate);
  }
}

// `2026-08-03` → `7973-91-96`: each digit becomes 9 minus itself, so an earlier date yields a greater string
// and a plain descending comparison puts the nearest deadline first. The dashes stay put, and every date is
// the same length, so the mapping is order-reversing across the whole vocabulary.
function complementDate(date: string): string {
  let out = "";
  for (const ch of date) out += ch >= "0" && ch <= "9" ? String(9 - Number(ch)) : ch;
  return out;
}

// Plain codepoint comparison, never `localeCompare`: the page CURSOR resumes with `<`, so a sort that ordered
// by collation instead would disagree with its own page boundary — locale collation is free to ignore the
// dashes in a date, and then two rows on either side of the boundary swap and one of them is never served.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Newest/most-urgent first, ties broken by (updatedAt, id) descending so the sequence is total — without a
// unique tail, two issues sharing a priority could swap places between pages and one of them would be lost.
export function compareIssuesForList(a: IssueOrderable, b: IssueOrderable, order: IssueOrder): number {
  return (
    compareText(issueOrderKey(b, order), issueOrderKey(a, order)) ||
    compareText(b.updatedAt, a.updatedAt) ||
    compareText(b.id, a.id)
  );
}

// Is `record` strictly AFTER the cursor position in the same sequence `compareIssuesForList` defines? The page
// boundary and the sort are therefore one rule, not two that happen to line up today.
export function isIssueAfterCursor(
  record: IssueOrderable,
  after: { key: string; updatedAt: string; id: string },
  order: IssueOrder,
): boolean {
  const key = issueOrderKey(record, order);
  if (key !== after.key) return key < after.key;
  if (record.updatedAt !== after.updatedAt) return record.updatedAt < after.updatedAt;
  return record.id < after.id;
}

// Counts per team over records already in hand — the in-memory half of `IssueStore.countByTeam`, shared so a
// fake and the real in-memory store cannot disagree about what "open" means.
export function issueCountsByTeam(records: readonly IssueRecord[]): { teamId: string; total: number; open: number }[] {
  const counts = new Map<string, { teamId: string; total: number; open: number }>();
  for (const record of records) {
    const entry = counts.get(record.teamId) ?? { teamId: record.teamId, total: 0, open: 0 };
    entry.total += 1;
    if (isOpenIssueStatus(record.status)) entry.open += 1;
    counts.set(record.teamId, entry);
  }
  return [...counts.values()];
}

// The addressable identity of the GitHub issue a copy came from, in the ONE shape every audit surface reads:
// the creation history entry, the `issue.created` fact, and the detach entry. `host` appears only for a GitHub
// Enterprise deployment (unset = github.com), the same convention WorkspaceCiLink uses.
function githubOrigin(github: IssueGithub): { repository: string; number: number; url: string; host?: string } {
  return {
    repository: github.repository,
    number: github.number,
    url: github.url,
    ...(github.host !== undefined ? { host: github.host } : {}),
  };
}

export class Issue {
  private constructor(private readonly record: IssueRecord) {}

  static from(record: IssueRecord): Issue {
    return new Issue(record);
  }

  // The only place an issue record literal is assembled — import and manual filing share it, so a GitHub copy
  // and a hand-written issue are the same shape from birth.
  static newIssue(input: NewIssueInput): IssueRecord {
    const status = input.status ?? "backlog";
    return {
      id: input.id,
      tenant: input.tenant,
      teamId: input.teamId,
      number: input.number,
      identifier: input.identifier,
      formerIdentifiers: [],
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status,
      priority: input.priority ?? "none",
      // A filed issue is IN the workflow; triage is the queue in front of it, entered explicitly by the
      // surfaces that bring work in from outside (import, an agent) — never the default for a member filing.
      inTriage: input.inTriage ?? false,
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      ...(input.stateId !== undefined ? { stateId: input.stateId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      labelIds: input.labelIds ?? [],
      links: (input.links ?? []).map((link) => ({
        type: link.type,
        id: link.id,
        ...(link.version !== undefined ? { version: link.version } : {}),
        ...(link.note !== undefined ? { note: link.note } : {}),
        addedBy: input.createdBy,
        addedAt: input.now,
      })),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.github !== undefined ? { github: input.github } : {}),
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: input.github !== undefined ? "github_imported" : "created",
          detail: {
            status,
            // The provenance entry is SELF-CONTAINED — host + url, not just `owner/name#42`. The `github` block
            // above is live link state a member can detach; this entry is the immutable record of where the
            // issue came from, and it has to stay resolvable afterwards. `owner/name#42` alone is not an
            // address on a GitHub Enterprise host, so reconstructing the link downstream is guesswork.
            ...(input.github !== undefined ? githubOrigin(input.github) : {}),
          },
        },
      ],
      createdBy: input.createdBy,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: IssueRecord): PlatformFact[] {
    return [
      {
        kind: "issue.created",
        subject: { type: "issue", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          source: record.github !== undefined ? "github" : "manual",
          teamId: record.teamId,
          identifier: record.identifier,
          // The fact is what feeds render — without the title a reader sees "ENG-12" and has to open it to
          // learn what was filed. Facts carry what a human needs to read the line, not just what filters match.
          title: record.title,
          ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
          // Same origin shape as the history entry: a consumer woken by this fact (an agent, a webhook) can
          // open the GitHub issue without a second read of the record — and without assuming github.com.
          ...(record.github !== undefined ? githubOrigin(record.github) : {}),
        },
        message: `${record.identifier} filed — ${record.title}`,
      },
    ];
  }

  isOpen(): boolean {
    return isOpenIssueStatus(this.record.status);
  }

  get status(): IssueStatus {
    return this.record.status;
  }

  get github(): IssueGithub | undefined {
    return this.record.github;
  }

  // Content editing — no facts. A retitled issue is not lifecycle news; the history entry is the audit trail.
  // `null` clears an optional field (unassign, detach from a project); `undefined` leaves it alone.
  update(fields: IssueEditInput, by: string, now: string): IssueTransition {
    const changed: string[] = [];
    const patch: Partial<IssueRecord> = {};
    if (fields.title !== undefined && fields.title !== this.record.title) {
      patch.title = fields.title;
      changed.push("title");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (fields.labelIds !== undefined) {
      patch.labelIds = fields.labelIds;
      // The history detail names what a READER sees ("labels"), not the storage field — the same token the
      // tracker-history renderer already knows, and it survives the string→id move unchanged.
      changed.push("labels");
    }
    if (fields.assignee !== undefined) {
      const next = fields.assignee === null ? undefined : fields.assignee;
      if (next !== this.record.assignee) {
        patch.assignee = next;
        changed.push("assignee");
      }
    }
    if (fields.projectId !== undefined) {
      const next = fields.projectId === null ? undefined : fields.projectId;
      if (next !== this.record.projectId) {
        patch.projectId = next;
        changed.push("project");
        // A milestone is a checkpoint INSIDE a project, so leaving the old one on an issue that just moved
        // projects would be the dangling reference the service refuses to create in the first place. Cleared
        // unless the same edit names a milestone — in which case that one is checked against the new project.
        if (fields.milestoneId === undefined && this.record.milestoneId !== undefined) {
          patch.milestoneId = undefined;
          changed.push("milestone");
        }
      }
    }
    if (fields.priority !== undefined && fields.priority !== this.record.priority) {
      patch.priority = fields.priority;
      changed.push("priority");
    }
    if (fields.estimate !== undefined) {
      const next = fields.estimate === null ? undefined : fields.estimate;
      if (next !== this.record.estimate) {
        patch.estimate = next;
        changed.push("estimate");
      }
    }
    if (fields.dueDate !== undefined) {
      const next = fields.dueDate === null ? undefined : fields.dueDate;
      if (next !== this.record.dueDate) {
        patch.dueDate = next;
        changed.push("dueDate");
      }
    }
    // The cycle move is the one edit whose VALUES go into the history, not just the field name. Everything else
    // can be answered by reading the issue as it stands; "which iteration was this in on the 9th" cannot, and
    // that is exactly what a burn-down replays. Without it an issue pulled in halfway through counts against the
    // whole window, and every cycle graph quietly lies about the days before the work existed.
    let cycleMove: { cycleFrom: string | null; cycleTo: string | null } | undefined;
    if (fields.cycleId !== undefined) {
      const next = fields.cycleId === null ? undefined : fields.cycleId;
      if (next !== this.record.cycleId) {
        patch.cycleId = next;
        changed.push("cycle");
        // Both ends, always, with `null` for "no cycle" — an absent key would be indistinguishable from an
        // edit made before this was recorded, which is the one case the replay has to treat differently.
        cycleMove = { cycleFrom: this.record.cycleId ?? null, cycleTo: next ?? null };
      }
    }
    if (fields.milestoneId !== undefined) {
      const next = fields.milestoneId === null ? undefined : fields.milestoneId;
      if (next !== this.record.milestoneId) {
        patch.milestoneId = next;
        changed.push("milestone");
      }
    }
    if (fields.parentId !== undefined) {
      const next = fields.parentId === null ? undefined : fields.parentId;
      // The aggregate can only see the obvious cycle; "my new parent is my own descendant" needs the live tree
      // and is refused by the service, which holds the store.
      if (next === this.record.id)
        throw new BadRequestError("BAD_REQUEST", { issue: this.record.id }, "An issue cannot be its own parent.");
      if (next !== this.record.parentId) {
        patch.parentId = next;
        changed.push("parent");
      }
    }
    if (changed.length === 0) throw new BadRequestError("BAD_REQUEST", { issue: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, {
      at: now,
      by,
      event: "updated",
      detail: { changed, ...(cycleMove !== undefined ? cycleMove : {}) },
    });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // Hand the issue to another team. The identifier is RE-MINTED from the destination's counter — the prefix's
  // whole job is to say whose list the issue is on, so a moved issue keeping `ENG-12` under the Platform team
  // would make the name a lie. The previous name is kept on the record (and stays resolvable) so every link
  // already pasted into a pull request still lands here, which is what makes re-minting affordable at all.
  // The service allocates the number from the destination team, exactly as filing does.
  //
  // A move also DROPS whatever the destination team does not own. Everything the issue points at across the
  // team axis was checked against the OLD team when it was set — its cycle, its board column, and (unless the
  // destination is on it too) its project with the milestone inside it. Carrying those across would leave the
  // issue in an iteration it can never appear in and a column that is not on its board: the invariant every
  // other path enforces, quietly false for exactly the issues that moved. What it loses is named in the
  // history, so the move never reads as a rename that silently emptied three fields.
  moveToTeam(input: IssueMoveInput, by: string, now: string): IssueTransition {
    if (input.teamId === this.record.teamId)
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, team: input.teamId },
        "This issue already belongs to that team.",
      );
    const fromTeamId = this.record.teamId;
    const fromIdentifier = this.record.identifier;
    // The project stays only when the destination team is on it — a project spans teams, so a move inside the
    // project's own set of teams is not a departure from the project.
    const keepsProject = this.record.projectId === undefined || input.projectHoldsTeam === true;
    const dropped = [
      ...(this.record.cycleId !== undefined ? ["cycle"] : []),
      ...(this.record.stateId !== undefined ? ["state"] : []),
      ...(keepsProject ? [] : ["project"]),
      ...(keepsProject || this.record.milestoneId === undefined ? [] : ["milestone"]),
    ];
    const detail = {
      fromTeamId,
      toTeamId: input.teamId,
      fromIdentifier,
      toIdentifier: input.identifier,
      ...(dropped.length > 0 ? { dropped } : {}),
    };
    return {
      patch: {
        teamId: input.teamId,
        number: input.number,
        identifier: input.identifier,
        // Counters only ever move forward, so a re-mint can never collide with a name this issue already had —
        // the Set is here for the shape's own sake, not to paper over a possible duplicate.
        formerIdentifiers: [...new Set([...this.record.formerIdentifiers, fromIdentifier])],
        cycleId: undefined,
        stateId: undefined,
        ...(keepsProject ? {} : { projectId: undefined, milestoneId: undefined }),
        history: appendHistory(this.record.history, { at: now, by, event: "moved", detail }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.moved",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: detail,
          message: `${fromIdentifier} moved to another team as ${input.identifier}`,
        },
      ],
    };
  }

  // Accept the issue INTO the team's workflow: the triage flag clears and the issue lands where the member
  // said (`todo` by default). It is its own transition rather than an `update`, because leaving the queue is a
  // lifecycle move — the history has to be able to answer "when did this stop being a request".
  acceptFromTriage(to: IssueStatus, by: string, now: string): IssueTransition {
    if (!this.record.inTriage)
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id },
        "This issue is not in triage — it is already in the workflow.",
      );
    if (to === "done" || to === "regressed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id, status: to },
        "Accepting an issue puts it into the workflow — close it afterwards, with its evidence.",
      );
    const from = this.record.status;
    return {
      patch: {
        inTriage: false,
        status: to,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "status_changed",
          detail: { from, to, triage: "accepted" },
        }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.status_changed",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: { from, to, cause: "manual", triage: "accepted", identifier: this.record.identifier },
          message: `${this.record.identifier} accepted from triage`,
        },
      ],
    };
  }

  // Ordinary workflow movement between OPEN states, plus cancellation. Reaching `done` goes through resolve()
  // (a closed issue must say what closed it) and `regressed` through reopen() (it only means anything as the
  // fall from a resolution).
  setStatus(to: IssueStatus, by: string, now: string, options: IssueStatusChangeOptions = {}): IssueTransition {
    if (to === "done")
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "Closing an issue records how it was evaluated — resolve it instead of setting the status directly.",
      );
    if (to === "regressed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "An issue can only regress from a resolution — reopen a done issue as regressed instead.",
      );
    if (to === this.record.status)
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is already ${this.record.status}.`,
      );
    if (isTerminal(this.record.status))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is ${this.record.status} — reopen it before moving it.`,
      );
    return this.statusTransition(to, by, now, options, "status_changed");
  }

  // → done, with the evidence. `resolution.scorecardId` is what makes "how was it evaluated and closed"
  // answerable, and it becomes the baseline the regression watch compares later runs against.
  resolve(
    resolution: { scorecardId?: string; note?: string },
    by: string,
    now: string,
    cause: IssueStatusCause = "manual",
  ): IssueTransition {
    if (!this.isOpen())
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is already ${this.record.status}.`,
      );
    const settled: IssueResolution = {
      ...(resolution.scorecardId !== undefined ? { scorecardId: resolution.scorecardId } : {}),
      ...(resolution.note !== undefined ? { note: resolution.note } : {}),
      by,
      at: now,
    };
    const transition = this.statusTransition(
      "done",
      by,
      now,
      { cause, ...(resolution.scorecardId !== undefined ? { scorecardId: resolution.scorecardId } : {}) },
      "resolved",
    );
    return { patch: { ...transition.patch, resolution: settled }, facts: transition.facts };
  }

  // Terminal → open again. The prior `resolution` is deliberately KEPT: a regressed issue must remember the
  // scorecard it fell from, and a manually reopened one keeps the record of how it was closed last time.
  reopen(input: IssueReopenInput, by: string, now: string): IssueTransition {
    if (!isTerminal(this.record.status))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is ${this.record.status} — only a done or cancelled issue can be reopened.`,
      );
    const to = input.to ?? "todo";
    if (!isOpenIssueStatus(to))
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id, status: to },
        "Reopen requires an open status.",
      );
    if (to === "regressed" && this.record.status !== "done")
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        "Only a resolved issue can regress.",
      );
    return this.statusTransition(
      to,
      by,
      now,
      {
        cause: input.cause,
        ...(input.scorecardId !== undefined ? { scorecardId: input.scorecardId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      "reopened",
    );
  }

  link(input: NewIssueLinkInput, by: string, now: string): IssueTransition {
    if (this.record.links.some((existing) => existing.type === input.type && existing.id === input.id))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, type: input.type, id: input.id },
        `${input.type} ${input.id} is already linked to this issue.`,
      );
    const link: IssueLink = {
      type: input.type,
      id: input.id,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      addedBy: by,
      addedAt: now,
    };
    return {
      patch: {
        links: [...this.record.links, link],
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "linked",
          detail: { type: link.type, id: link.id, ...(link.version !== undefined ? { version: link.version } : {}) },
        }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.linked",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: {
            linkType: link.type,
            linkId: link.id,
            identifier: this.record.identifier,
            ...(link.version !== undefined ? { version: link.version } : {}),
          },
          message: `Issue linked to ${link.type} ${link.id} — ${this.record.title}`,
        },
      ],
    };
  }

  unlink(type: IssueLinkType, id: string, by: string, now: string): IssueTransition {
    const remaining = this.record.links.filter((link) => !(link.type === type && link.id === id));
    if (remaining.length === this.record.links.length)
      throw new NotFoundError(
        "NOT_FOUND",
        { issue: this.record.id, type, id },
        `${type} ${id} is not linked to this issue.`,
      );
    return {
      patch: {
        links: remaining,
        history: appendHistory(this.record.history, { at: now, by, event: "unlinked", detail: { type, id } }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // --- GitHub copy seams (P1) ---
  // All of these patch FIELDS only. A remote open/closed change reaches our status through resolve()/reopen(),
  // so a sync-driven close emits the same fact a member's close does and the history reads the same.

  setGithubSync(sync: IssueGithubSync, by: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: { github: { ...github, sync }, updatedAt: now },
      facts: [],
    };
  }

  // Detaching removes the LIVE link, never the provenance: the entry carries the same addressable origin the
  // import entry did, so "where did this come from" still answers after someone unhooks the sync.
  detachGithub(by: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: {
        github: undefined,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "updated",
          detail: {
            changed: ["github"],
            detached: `${github.repository}#${github.number}`,
            ...githubOrigin(github),
          },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // Remote-owned fields land verbatim (GitHub is the source of record for title/body/labels/comments) and
  // `syncedAt` records the REMOTE clock reading — the watermark that both skips unchanged issues and swallows
  // the echo of our own push. `labelIds` arrives already resolved: the caller maps GitHub's label NAMES onto the
  // workspace registry (creating what is missing) before it gets here, because that lookup is I/O.
  applyGithubPull(
    remote: {
      title: string;
      description?: string;
      labelIds: string[];
      state: "open" | "closed";
      url: string;
      updatedAt: string;
      comments: IssueGithubComment[];
    },
    by: string,
    now: string,
  ): IssueTransition {
    const github = this.requireGithub();
    const changed: string[] = [];
    if (remote.title !== this.record.title) changed.push("title");
    if (remote.description !== this.record.description) changed.push("description");
    // \0 must stay ESCAPED: a literal NUL byte in the source makes this file binary to grep and to
    // git diff, which quietly removes the tracker's core aggregate from every code search.
    if (remote.labelIds.join("\0") !== this.record.labelIds.join("\0")) changed.push("labels");
    if (remote.state !== github.state) changed.push("state");
    // lastError is dropped by omission — a successful pull clears whatever failed before it.
    const { lastError: _cleared, ...rest } = github;
    const nextGithub: IssueGithub = {
      ...rest,
      url: remote.url,
      state: remote.state,
      syncedAt: remote.updatedAt,
      comments: remote.comments.slice(-ISSUE_GITHUB_COMMENT_LIMIT),
    };
    return {
      patch: {
        title: remote.title,
        description: remote.description,
        labelIds: remote.labelIds,
        github: nextGithub,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "github_pulled",
          detail: { changed, remoteState: remote.state, remoteUpdatedAt: remote.updatedAt },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // Best-effort by contract: the local transition is already committed, so a push outcome only ever annotates.
  recordGithubPush(
    outcome: { ok: true; state: "open" | "closed" } | { ok: false; message: string },
    by: string,
    now: string,
  ): IssueTransition {
    const github = this.requireGithub();
    if (outcome.ok) {
      const { lastError: _cleared, ...rest } = github; // a successful push clears the previous failure
      const nextGithub: IssueGithub = { ...rest, state: outcome.state };
      return {
        patch: {
          github: nextGithub,
          history: appendHistory(this.record.history, {
            at: now,
            by,
            event: "github_pushed",
            detail: { state: outcome.state },
          }),
          updatedAt: now,
        },
        facts: [],
      };
    }
    return {
      patch: {
        github: { ...github, lastError: { at: now, op: "push", message: outcome.message } },
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "github_push_failed",
          detail: { message: outcome.message },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  recordGithubPullFailure(message: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: { github: { ...github, lastError: { at: now, op: "pull", message } }, updatedAt: now },
      facts: [],
    };
  }

  private requireGithub(): IssueGithub {
    const github = this.record.github;
    if (github === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "This issue is not linked to a GitHub issue.",
      );
    return github;
  }

  // The one place a status move becomes a patch + the folded `issue.status_changed` fact, so every path
  // (member, GitHub sync, regression watch) produces an identically-shaped fact that payload filters can match.
  private statusTransition(
    to: IssueStatus,
    by: string,
    now: string,
    options: IssueStatusChangeOptions,
    event: "status_changed" | "resolved" | "reopened",
  ): IssueTransition {
    const from = this.record.status;
    const cause: IssueStatusCause = options.cause ?? "manual";
    const detail = {
      from,
      to,
      cause,
      ...(options.scorecardId !== undefined ? { scorecardId: options.scorecardId } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
    };
    return {
      patch: {
        status: to,
        // The board column the move landed in, when the caller moved by column. A move made by canonical status
        // (the regression watch, a GitHub sync, an agent) leaves it alone — the issue is then in no column, and
        // a reader falls back to the team's default state for that status, which is the honest reading.
        ...(options.stateId !== undefined ? { stateId: options.stateId } : {}),
        history: appendHistory(this.record.history, { at: now, by, event, detail }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.status_changed",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: {
            from,
            to,
            cause,
            teamId: this.record.teamId,
            identifier: this.record.identifier,
            title: this.record.title,
            ...(this.record.projectId !== undefined ? { projectId: this.record.projectId } : {}),
            ...(options.scorecardId !== undefined ? { scorecardId: options.scorecardId } : {}),
          },
          message: `${this.record.identifier} ${from} → ${to} — ${this.record.title}`,
        },
      ],
    };
  }
}
