import type { PlatformEventRecord, RunRecord } from "@everdict/contracts";
import type { AdmissionLedger } from "./admission-ledger.js";

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
// A live SESSION as the LEDGER sees it — the fact every hold-open lane must share. A per-process map counts
// only what THIS replica happens to hold, so a control plane running more than one instance admits its cap
// once per replica; the ledger is the single place that knows what a workspace is actually holding open.
// Kept deliberately thin: session caps are single digits, so callers read the whole set and count in memory
// rather than asking the store one question per policy dimension.
export interface LiveSessionRow {
  id: string;
  tenant: string;
  createdBy?: string;
  agentId?: string; // session.agent.agentId — the per-agent session cap
  expiresAt?: string; // the hard deadline; what a capacity refusal reports as `freesAt`
}

export interface LiveSessionQuery {
  tenant?: string; // unset = the whole fleet (the global cap)
  // WHICH pool. Sessions share `kind: "sandbox"` (held-open isolated compute) but not their caps: an agent
  // world and a login browser are bounded separately, and the run's `trigger` is what tells them apart.
  trigger?: string;
}

// The run ledger. It also IS the `AdmissionLedger` (see that port): the scheduler's fleet-wide tenant count is
// derived from these very rows, so the control plane hands its store over instead of keeping a second ledger.
// The scoring-pass FENCE (arch-review 8 P0). The score plane lives on child run rows, so "only the current
// pass may mutate it" is a condition about ANOTHER row — and it has to be evaluated in the same statement as
// the write. Checking it in the service first would be the very TOCTOU it exists to close: between "the
// marker still names me" and the write, the winning pass can settle and clear the marker, and the late write
// then lands on a settled plane with nothing left to refuse it. A superseded pass waking hours later is the
// real shape of this, which is why the guard is a storage-layer condition and not a service-layer check.
export interface RunScoringFence {
  scorecardId: string; // the parent whose marker decides
  passId: string; // the pass claiming the right to write — must still be the marker's owner
}

// THE CONDITIONS A RUN WRITE COMMITS UNDER. Both are storage-layer for the same reason: a service that reads
// the row, decides, and then writes has left a window open between the two, and the writers this guards
// against are in ANOTHER PROCESS — a cancel in the control plane against a case drain landing from a worker.
export interface RunUpdateGuard {
  // Commit only while the named scoring pass still owns the parent scorecard's marker.
  scoring?: RunScoringFence;
  // FIRST TERMINAL WRITE WINS — as a condition on the write rather than a sentence in a comment.
  //
  // `settleChild` read the row, checked `isTerminal()`, and wrote. Across two processes that is a TOCTOU with
  // the outcome inverted: both read a running child, both write, and the LAST write wins. A user cancels a
  // batch, the child settles `failed{CANCELLED}`, and a case that was already past the point of no return
  // lands `succeeded` on top — so the ledger says a cancelled batch's child succeeded, and every aggregate
  // over it counts a result the user stopped.
  expectNonTerminal?: true;
}

export interface RunStore extends AdmissionLedger {
  create(record: RunRecord, events?: OutboxEvent[]): Promise<void>;
  // `fence`: commit ONLY while the named scoring pass still owns the parent scorecard's marker. A miss
  // returns undefined (like a missing id) — the caller treats it as "I was superseded" and stops.
  update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    guard?: RunUpdateGuard,
  ): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
  // Remove every child run a scorecard fanned out (scorecard hard-delete cascade — orphaned children would
  // otherwise linger in the "all executions" view). Returns the number of runs removed.
  deleteByScorecard(scorecardId: string): Promise<number>;
  // O7's third knob (the in-flight cap): how many NON-TERMINAL runs currently draw from this envelope.
  // Read from the ledger itself — never a counter to reconcile — so a tombstoned run can't leak a slot.
  countActiveByEnvelope(tenant: string, envelopeId: string): Promise<number>;
  // Session runs that have not settled. Deliberately NO time predicate: whether a deadline has passed is a
  // question about a clock, and the clock that wrote `expiresAt` belongs to the service, not to the store —
  // the caller drops the overdue rows (and must: a crashed writer's row would otherwise hold a workspace's
  // session slot forever, which no member can recover from).
  liveSessions(query?: LiveSessionQuery): Promise<LiveSessionRow[]>;
}
