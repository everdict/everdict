import type { PlatformEventRecord, RunRecord } from "@everdict/contracts";

// list options. The default (unset) returns only standalone runs — hides scorecard child runs to prevent activity-list flooding.
// With scorecardId, returns only that batch's child runs (for the case drill-down in scorecard detail).
// With includeChildren, returns standalone runs AND scorecard children together (the activity console's "all executions"
// view — the UI groups children under their scorecard). Ignored when scorecardId is set (that already targets one batch).
export interface RunListOptions {
  scorecardId?: string;
  includeChildren?: boolean;
  // Runs a given self-hosted runner executed (result.provenance.runner === runnerId) — the runner-detail activity
  // feed. Implies includeChildren (a runner mostly runs scorecard cases). Only completed runs carry provenance, so
  // this returns finished runs, newest first.
  runnerId?: string;
  // Cap the number of rows returned (newest first) — the activity feed only needs the recent slice. Unset = no cap.
  limit?: number;
  // Skip the first N rows (newest first) before applying limit — offset pagination for the runner-detail activity
  // feed (each page fetches exactly `limit` rows at `offset = page * limit`). Unset/0 = start from the newest.
  offset?: number;
  // WHO is reading (a member subject). Personal executions — agent turns, sandbox shells — belong to the member
  // who did them (`runAudience` in @everdict/domain), so the store drops another member's from the page. Applied
  // in the QUERY, not after it: filtering a limited page would let one member's chat history push everyone else's
  // runs off the reader's screen. Unset = an internal read (recovery, reapers, the usage meter) that is not
  // serving a person — never pass it through from a transport.
  viewer?: string;
  // The teams whose runs this caller may see — `TeamService.visibleTeamIds`, the one place team privacy is
  // decided. A run of a PRIVATE team is that team's work; an unowned one (no `teamId`) is the workspace's and is
  // always kept. `undefined` = nothing is hidden, never "no teams". Orthogonal to `viewer` above: that hides one
  // MEMBER's personal executions, this hides one TEAM's work, and both narrow the same page.
  visibleTeams?: string[];
}

// A platform event stamped with identity but not yet sequenced — what the same-tx outbox persists alongside
// the write it describes (event-plumbing.md E0). The store assigns seq (the log's cursor) on insert.
export type OutboxEvent = Omit<PlatformEventRecord, "seq">;

// Result store contract. in-memory (dev/test) or Postgres (production) — swapped behind the same interface.
// `events` (optional) is the E0 outbox: implementations persist them ATOMICALLY with the write (Postgres: one
// data-modifying-CTE statement; in-memory: same-process append). Callers stamp id/tenant/createdAt; consumers
// dedup on the event id, so the same id may safely also travel the push path.
export interface RunStore {
  create(record: RunRecord, events?: OutboxEvent[]): Promise<void>;
  update(id: string, patch: Partial<RunRecord>, events?: OutboxEvent[]): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
  // Remove every child run a scorecard fanned out (scorecard hard-delete cascade — orphaned children would
  // otherwise linger in the "all executions" view). Returns the number of runs removed.
  deleteByScorecard(scorecardId: string): Promise<number>;
  // O7's third knob (the in-flight cap): how many NON-TERMINAL runs currently draw from this envelope.
  // Read from the ledger itself — never a counter to reconcile — so a tombstoned run can't leak a slot.
  countActiveByEnvelope(tenant: string, envelopeId: string): Promise<number>;
}
