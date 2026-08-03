import type { IssueLinkType, IssuePage, IssuePriority, IssueRecord, IssueStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface IssueListFilter {
  status?: IssueStatus;
  // The owning team, or several — "my teams" is a list of ids, not a join, because the caller already resolved
  // the subject's roster and passing it down keeps the store free of a membership dependency.
  teamId?: string;
  teamIds?: string[];
  projectId?: string;
  assignee?: string;
  priority?: IssuePriority;
  // One iteration's board, and the team's triage inbox — both are narrow slices of one team's issues.
  cycleId?: string;
  // One project checkpoint's issues.
  milestoneId?: string;
  // One board column's issues — what a state's delete gate counts and what a re-mapped state re-stamps.
  stateId?: string;
  inTriage?: boolean;
  // The sub-issues of one parent. `null` selects the TOP-LEVEL issues instead — "everything that is not
  // somebody's sub-issue", which is what a board wants to show so a child never appears twice.
  parentId?: string | null;
  // Issues that point at a given capability — powers "which issues watch this harness" and the regression
  // watch's candidate lookup (id-level, version-agnostic: a cross-version regression is exactly the signal).
  link?: { type: IssueLinkType; id: string };
  githubRepository?: string;
  syncPull?: boolean; // only issues whose GitHub copy has pull enabled (the manual bulk sync's working set)
  limit?: number;
}

// The list projection's filter: the same narrowing plus the page cursor. Separate from `IssueListFilter` because
// only the paginated path has a cursor, and a filter field with no caller on the other path is surface we would
// have to explain.
export interface IssuePageFilter extends IssueListFilter {
  cursor?: string; // opaque token from a prior page's nextCursor; absent = the first page
}

// How many issues each team holds, and how many of those are still open — the counts a team list row shows.
// Derived on read like ProjectRollup, but as ONE aggregate over the issue table rather than a fetch per team:
// the team list used to read (and Zod-parse) every issue in the workspace to produce three integers per row.
export interface IssueTeamCounts {
  teamId: string;
  total: number;
  open: number;
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
  countByTeam(tenant: string): Promise<IssueTeamCounts[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
