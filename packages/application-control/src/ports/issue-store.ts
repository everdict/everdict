import type { IssueLinkType, IssueRecord, IssueStatus } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface IssueListFilter {
  status?: IssueStatus;
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
