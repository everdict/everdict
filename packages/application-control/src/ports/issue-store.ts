import type {
  IssueGroupBy,
  IssueGroupCount,
  IssueLinkType,
  IssueOrder,
  IssuePage,
  IssuePriority,
  IssueRecord,
  IssueStatus,
} from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface IssueListFilter {
  status?: IssueStatus;
  projectId?: string;
  assignee?: string;
  priority?: IssuePriority;
  // One project checkpoint's issues.
  milestoneId?: string;
  // One board column's issues — what a state's delete gate counts and what a re-mapped state re-stamps.
  stateId?: string;
  // The sub-issues of one parent. `null` selects the TOP-LEVEL issues instead — "everything that is not
  // somebody's sub-issue", which is what a board wants to show so a child never appears twice.
  parentId?: string | null;
  // Issues that point at a given capability — powers "which issues watch this harness" and the regression
  // watch's candidate lookup (id-level, version-agnostic: a cross-version regression is exactly the signal).
  link?: { type: IssueLinkType; id: string };
  // Issues CONNECTED TO a set of scorecards — linked to one, or closed by one. Both halves are the same
  // question ("did this evidence have anything to do with this issue"), and answering only the link half would
  // miss exactly the issues that matter most: the ones a scorecard PROVED, which record their evidence in
  // `resolution.scorecardId` and get no link from it. A set rather than a value because the caller (the product
  // timeline) holds a batch of scorecards and one query is not the same cost as one query per batch. An empty
  // array selects nothing, the same reading the set-per-facet filters below take.
  scorecards?: string[];
  // Free-text search over what an issue is CITED by — its identifier (`ENG-12`, including the ones it used to
  // answer to) and its title. Not the description: a picker that has to say why a row matched cannot show a
  // paragraph, and "the title contains it" is the one match a person can verify at a glance. Case-insensitive,
  // substring, ANDed with every other filter.
  query?: string;
  githubRepository?: string;
  syncPull?: boolean; // only issues whose GitHub copy has pull enabled (the manual bulk sync's working set)
  limit?: number;
  // --- The SCREEN's filters: a set per facet, not a value ---
  // "Everything still in flight" is `todo OR in_progress OR in_review`, and a caller that could only name one
  // status at a time had to ask three times and merge the pages — which no cursor makes correct. Each of these
  // selects rows matching ANY of the given values (an empty array selects nothing, because "filtered to
  // nothing" is what the caller asked for); ACROSS facets they AND, which is how a filter bar reads. The
  // singular fields above stay for the internal callers that narrow to exactly one value (the rollups, the
  // regression watch) and AND with these.
  statuses?: IssueStatus[];
  priorities?: IssuePriority[];
  assignees?: string[];
  projectIds?: string[];
  cycleIds?: string[];
  // Labels are the one MANY-valued column: an issue carries a set, so a row matches when the two sets
  // intersect. That is the only reading a label filter can have — "has any of these labels".
  labelIds?: string[];
}

// The list projection's filter: the same narrowing plus the page cursor. Separate from `IssueListFilter` because
// only the paginated path has a cursor, and a filter field with no caller on the other path is surface we would
// have to explain.
export interface IssuePageFilter extends IssueListFilter {
  cursor?: string; // opaque token from a prior page's nextCursor; absent = the first page
  // How the page is ordered — `updated` (newest touched first) when absent. The cursor is minted UNDER this
  // ordering and carries it, so a page token read back with a different `order` is refused rather than
  // silently resuming from a position that means nothing in the new sequence.
  order?: IssueOrder;
}

// The tracker's issue ledger. `events` is the E0 outbox: implementations persist the facts ATOMICALLY with the
// write they describe (Postgres: one data-modifying-CTE statement) — the same contract RunStore/ScorecardStore
// hold, because the tracker's aggregates are ours and their transitions are the state change.
export interface IssueStore {
  create(record: IssueRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<IssueRecord | undefined>;
  // The addressable identity (`ENG-12`) — unique per workspace, so a link people paste resolves to exactly one
  // issue. Reads and mutations both arrive by it, because it is what the URL and the MCP tools carry.
  // Implementations match the CURRENT identifier first and then the record's `formerIdentifiers`: a team move
  // re-mints the name, and a link that was correct when it was pasted has to keep working afterwards.
  getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined>;
  // The imported-copy identity — import dedup (re-importing the same GitHub issue is a no-op) and pull matching.
  getByGithub(tenant: string, repository: string, number: number, host?: string): Promise<IssueRecord | undefined>;
  // The WHOLE record, for the callers that need the whole record — the regression watch, the GitHub sync, the
  // project/initiative rollups. Not the list transports: those serve `listSummaries`.
  list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]>;
  // One PAGE of the list projection (`IssueSummary`, newest-updated first). This is what `GET /issues` and the
  // `list_issues` tool serve: implementations read only the projected columns, so an issue's description and
  // audit trail are never fetched — let alone parsed — to draw a row that shows neither.
  listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage>;
  // Issue counts per team in one aggregate. Absent teams simply have no entry (a team with no issues).
  // How many issues fall in each group under `filter` — what a GROUPED list's headers show. One aggregate, not
  // a count per group: a screen grouped by assignee would otherwise fire a query per member to learn how many
  // rows it is not showing. Groups come back largest-first; the unset bucket carries `key: null`.
  countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
