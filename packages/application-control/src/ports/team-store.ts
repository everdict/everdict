import type { TeamMemberRecord, TeamRecord } from "@everdict/contracts";
import type { OutboxEvent } from "./run-store.js";

export interface TeamListFilter {
  // Only the teams this subject belongs to — what "my teams" means on an issue list. Absent = every team in the
  // workspace (the settings roster, and the picker an admin uses when filing into someone else's team).
  member?: string;
  limit?: number;
}

// A number and the identifier built from it, handed out atomically. The store owns the increment because "two
// issues must never share ENG-12" is a concurrency property, not a domain rule — the domain says what the next
// number MEANS (Team.allocateIssueNumber), the store guarantees only one caller gets it.
export interface IssueNumberGrant {
  number: number;
  identifier: string;
}

// The tracker's team ledger + its roster. `events` is the E0 outbox: implementations persist facts ATOMICALLY
// with the write they describe, the same contract IssueStore holds.
export interface TeamStore {
  create(record: TeamRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<TeamRecord | undefined>;
  getByKey(tenant: string, key: string): Promise<TeamRecord | undefined>;
  // The landing place for an issue filed without a team. Absent only in a workspace that has never had one,
  // which the service repairs by creating it (a workspace keeps at least one team).
  getDefault(tenant: string): Promise<TeamRecord | undefined>;
  list(tenant: string, filter?: TeamListFilter): Promise<TeamRecord[]>;
  count(tenant: string): Promise<number>;
  update(
    tenant: string,
    id: string,
    patch: Partial<TeamRecord>,
    events?: OutboxEvent[],
  ): Promise<TeamRecord | undefined>;
  remove(tenant: string, id: string): Promise<void>;
  // One conditional UPDATE … RETURNING — never read-then-write, which would let two concurrent filings read the
  // same counter. Returns undefined when the team is gone.
  allocateIssueNumber(tenant: string, id: string, now: string): Promise<IssueNumberGrant | undefined>;

  listMembers(tenant: string, teamId: string): Promise<TeamMemberRecord[]>;
  // Roster sizes for every team in the workspace, in one aggregate — the team list's `memberCount` column.
  // A team with an empty roster simply has no entry. The per-team `listMembers` stays for the detail view,
  // where the caller actually wants the names.
  countMembersByTeam(tenant: string): Promise<{ teamId: string; count: number }[]>;
  addMember(record: TeamMemberRecord, events?: OutboxEvent[]): Promise<void>;
  removeMember(tenant: string, teamId: string, subject: string, events?: OutboxEvent[]): Promise<boolean>;
}
