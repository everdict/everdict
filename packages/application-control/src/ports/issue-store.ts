import type { IssueLinkType, IssueRecord, IssueStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface IssueListFilter {
  status?: IssueStatus;
  // The owning team, or several — "my teams" is a list of ids, not a join, because the caller already resolved
  // the subject's roster and passing it down keeps the store free of a membership dependency.
  teamId?: string;
  teamIds?: string[];
  projectId?: string;
  assignee?: string;
  // Issues that point at a given capability — powers "which issues watch this harness" and the regression
  // watch's candidate lookup (id-level, version-agnostic: a cross-version regression is exactly the signal).
  link?: { type: IssueLinkType; id: string };
  githubRepository?: string;
  syncPull?: boolean; // only issues whose GitHub copy has pull enabled (the manual bulk sync's working set)
  limit?: number;
}

// The tracker's issue ledger. `events` is the E0 outbox: implementations persist the facts ATOMICALLY with the
// write they describe (Postgres: one data-modifying-CTE statement) — the same contract RunStore/ScorecardStore
// hold, because the tracker's aggregates are ours and their transitions are the state change.
export interface IssueStore {
  create(record: IssueRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<IssueRecord | undefined>;
  // The addressable identity (`ENG-12`) — unique per workspace, so a link people paste resolves to exactly one
  // issue. Reads and mutations both arrive by it, because it is what the URL and the MCP tools carry.
  getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined>;
  // The imported-copy identity — import dedup (re-importing the same GitHub issue is a no-op) and pull matching.
  getByGithub(tenant: string, repository: string, number: number, host?: string): Promise<IssueRecord | undefined>;
  list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]>;
  update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
}
