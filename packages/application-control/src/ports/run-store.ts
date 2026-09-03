import type { PlatformEventRecord, RunRecord, RunStatus } from "@everdict/contracts";
import type { AdmissionLedger } from "./admission-ledger.js";
import type { ExecutionAttemptStore } from "./execution-attempt-store.js";
import type { IntermediateCleanupStore } from "./intermediate-cleanup-store.js";

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
  // ── "ONLY THE RUNS IN THESE STATES", BECAUSE THAT IS WHAT THE CALLERS WANTED (perf review) ────────
  //
  // Two readers asked for the whole run ledger and then kept the handful of ACTIVE rows: the queue snapshot
  // (`runs.list(tenant)`) and boot recovery (`runs.list()` — with no tenant at all, so every workspace's).
  // The adapter's projection is `SELECT *`, which carries the heavy `result` jsonb, and `limit` defaults to
  // unlimited — so both read the entire ledger, including finished runs' snapshots, to find the few rows
  // that were still moving.
  //
  // Applied in the QUERY, beside `viewer`/`visibleTeams` and for the same reason those are: a page narrowed
  // afterwards is the wrong size. Empty array = chosen and nothing matches, never "no filter".
  statuses?: readonly RunStatus[];
}

// A platform event stamped with identity but not yet sequenced — what the same-tx outbox persists alongside
// the write it describes (event-plumbing.md E0). The store assigns seq (the log's cursor) on insert.
export type OutboxEvent = Omit<PlatformEventRecord, "seq">;

// ── HOW MANY CHILDREN, IN WHICH STATE — WITHOUT READING THE CHILDREN (perf review) ──────────────────
//
// The queue screen shows each running batch's progress as done/active/waiting. It computed that by LISTING
// every child of every running batch — `runs.list(tenant, { scorecardId })`, once per batch, and the adapter's
// projection is `SELECT *`, so a 600-case batch shipped 600 rows of `result` jsonb (snapshots and all) to
// produce three integers. N+1 in the number of running batches, and each of the N unbounded in dataset size.
//
// One grouped read answers every batch at once, and it reads only the column the answer depends on.
export interface RunChildStatusCount {
  scorecardId: string;
  status: RunStatus;
  count: number;
}

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
// The condition on a child's CREATION — the same cross-row question its later writes ask, at the moment the
// work is committed to rather than at the moment it is recorded.
export interface RunCreateGuard {
  parentDriver: { scorecardId: string; epoch: number };
}

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
  // FIRST TERMINAL WRITE WINS FOR THE PAYLOAD TOO (arch-review 25 P1). `expectNonTerminal` fenced the STATUS
  // race and left the other half open: the batch's write-back reflects each case's final result onto its child
  // afterwards, unconditionally, so a case that was already past the point of no return when the user stopped
  // the batch still landed a successful `result` on a row whose status says CANCELLED. Status and payload are
  // one settlement; a row that carries both readings is not a smaller record, it is a self-contradicting one.
  //
  // Deliberately narrower than "any terminal row": a case that ran and FAILED still has a real result the
  // write-back is supposed to reflect. What must not be overwritten is the settlement that says the work was
  // abandoned.
  expectNotCancelled?: true;
  // THE ROW HAS NOT PUBLISHED A RESULT YET (arch-review 46). The write-back that reflects a case's final
  // result onto its child guarded this with a READ two lines up (`if (current?.result) continue`) — the
  // exact read-check-write shape every fence in this vocabulary exists to abolish, applied to the payload
  // instead of the status. As a condition on the statement, a result that landed between the read and the
  // write refuses this one instead of being overwritten by it.
  expectNoResult?: true;
  // THE RECOVERY CLAIM (arch-review 28 P1). `expectNonTerminal` says the run is still open; it does not say
  // WHO may take it, so two booting replicas both cleared it and both re-dispatched. Ownership and the
  // authority to drive the work are one transition: a string means "the owner must still be this one" (the
  // dead replica the recovery observed), `null` means "there must be no owner recorded".
  expectOwnerReplica?: string | null;
  // …AND THE FENCE THAT REVOKES THE DRIVER IT REPLACED (arch-review 31 P1, mig 0170). The claim above is an
  // ELECTION: it decides who may take a dead replica's run, and it is silent to the replica that was not
  // actually dead. That one comes back holding an execution loop and settles the run on the strength of
  // "the row is open", which is true for both. The epoch is the number its write fails against.
  //
  // The driver carries the value it won from `create` or from its claim — never a value re-read at settle
  // time, which is exactly what a displaced driver would also read.
  expectOwnerEpoch?: number;
  // …and RAISES it in the same statement. A claim that stamped identity and left the token where it was would
  // announce the takeover to nobody.
  claimOwnership?: true;
  // THE PARENT'S DRIVER, AS A CONDITION ON THE CHILD'S WRITE (arch-review 33 P0).
  //
  // A child's own epoch answers "did somebody take over THIS run" and says nothing about the batch that owns
  // it: a parent takeover raises the SCORECARD's epoch and leaves every child at the number it had. So a
  // replica displaced from a batch could still adopt, tombstone and settle that batch's children — each write
  // passing a fence that was never about the authority it had lost.
  //
  // Evaluated inside the write statement, like the scoring fence next to it, because the alternative is a
  // read-then-write whose window is exactly the takeover it exists to catch.
  parentDriver?: { scorecardId: string; epoch: number };
  // ── THE DECISION AND ITS OWED TEARDOWN, IN ONE WRITE (arch-review 52, Wave 3) ─────────────────────
  //
  // Not a fence — an INSTRUCTION, and the only one in this vocabulary: the write that commits a run's
  // CANCELLED decision also inserts the cancellation operation that says its teardown is owed. The batch
  // lane has carried this on its own settle since arch-review 51; the standalone lane committed the
  // decision and then ran the teardown with nothing behind it, so a process that died in between left a
  // run that is terminal in the ledger and still burning on the cluster, with nobody looking.
  //
  // It rides the settle rather than being a second call for the reason every pair in this file rides its
  // statement: two commits have a window, and the window is exactly the crash this row exists to survive.
  // Applied ONLY when the settle matched a row — a refused settle decided nothing and owes nothing.
  requestCancellation?: true;
}

// ── THE LEDGER WRITE THAT RIDES A TERMINAL SETTLEMENT (arch-review 45) ───────────────────────────────
//
// A run's physical attempt has to end where the run ends, and "settle, then stamp" is two commits with a
// window between them: a crash there leaves a SUCCEEDED run whose attempt row still says `created` — a
// ledger that never saw the execution end, for an outcome the world has already been told about. The batch
// lane closed that window by putting the stamp inside `commitCase`'s transaction; this is the same thing for
// the lane whose outcome record IS the run row, so there is no receipt to claim, only a fenced terminal write
// to ride.
export interface AttemptStamp {
  // WHICH attempt this settlement is about. Named rather than hidden inside `apply`, because a settlement
  // that is refused has to be able to take the stamp back, and a store without a transaction cannot roll one
  // back for free (arch-review 63 P1-high).
  attemptId: string;
  // The caller's AMBIENT ledger. An implementation that can open a transaction ignores it and hands `apply` a
  // transaction-bound twin instead (exactly as `commitCase` does for the run store); one that cannot hands
  // this back. Passed by the caller rather than wired at construction, so the store the stamp lands in can
  // never drift from the one the attempt was opened on.
  attempts: ExecutionAttemptStore;
  // What to write on the attempt, through whichever ledger the store hands it. A refused TRANSITION is a
  // silent no-op by contract (the state machine's ordinary answer) and must not abort anything; only a THROW
  // — a store fault — takes the settlement down with it.
  apply: (attempts: ExecutionAttemptStore) => Promise<void>;
}

// ── …AND THE RELEASE THAT RIDES THE SAME DECISION (arch-review 70 P1) ───────────────────────────────
//
// The cleanup ledger became durable in arch-review 68 and its RELEASE stayed a second commit: the settlement
// transaction committed, and `releaseForGc` ran afterwards as an ordinary call. A crash in that gap leaves
// the row `retained` — and `due()` deliberately returns only released states, because a retained artifact is
// one a recovery may still need. So the intermediates of an execution that is already terminal are kept
// forever. Not a failed delete: a row that never became eligible to be deleted.
//
// Same rider shape as `AttemptStamp`, for the same reason: the write that makes an outcome canonical is the
// write that makes its intermediates collectable, and two commits have a window.
//
// ⚠️ ONLY THE STATE FLIP RIDES THE TRANSACTION. The object deletes stay outside it — an S3 round trip inside
// a database transaction holds a connection open on a remote service's latency, and the deletes are a
// latency optimization whose failure costs nothing because the reconciler owns convergence (rule `protocol`,
// "an inline cleanup after a commit is not a lifecycle"). What must be atomic is `retained → gc_owed`.
export interface CleanupRelease {
  // The caller's AMBIENT ledger, ignored by a store that can open a transaction — exactly as `AttemptStamp`
  // carries one so the row this lands in can never drift from the one the debt was recorded on.
  cleanup: IntermediateCleanupStore;
  // Flip the debt through whichever ledger the store hands over, and keep what it freed: the caller deletes
  // those objects AFTER the commit. A throw takes the settlement down with it, which is correct — the same
  // database is answering both, so a fault here is a fault there.
  apply: (cleanup: IntermediateCleanupStore) => Promise<void>;
}

export interface RunStore extends AdmissionLedger {
  // THE CHILD ROW IS THE DISPATCH INTENT (arch-review 33 P1). A batch creates a case's child run immediately
  // before dispatching it, so conditioning that INSERT on the parent's fencing token is what makes "may I
  // spend compute for this batch" one atomic decision rather than a proof followed by a hopeful gap. A driver
  // displaced between its authority proof and this insert writes no row — and no row means no dispatch.
  //
  // A refused condition THROWS `ConflictError` — the same answer `proveAuthority` gives, so the batch loop
  // aborts through the path it already has. (A boolean would have changed the signature every hand-rolled
  // fake in the repository implements; an added optional parameter changes none of them, which is the same
  // reason `settleRun` is a free function rather than a port method.) Without a guard: the unconditional
  // insert it always was.
  create(record: RunRecord, events?: OutboxEvent[], guard?: RunCreateGuard): Promise<void>;
  // `fence`: commit ONLY while the named scoring pass still owns the parent scorecard's marker. A miss
  // returns undefined (like a missing id) — the caller treats it as "I was superseded" and stops.
  update(
    id: string,
    patch: Partial<RunRecord>,
    events?: OutboxEvent[],
    guard?: RunUpdateGuard,
  ): Promise<RunRecord | undefined>;
  // The STANDALONE lane's commit point: the same fenced write `update` makes, plus the attempt's terminal
  // stamp, as ONE decision. Returns what `update` returns — the settled record, or undefined when the fence
  // refused, and a refusal runs no stamp and rolls nothing back (the loser wrote nothing to undo). A stamp
  // that THROWS takes the terminal write with it: the ledger could not record what the row is about to say.
  //
  // OPTIONAL, and the optionality is the fallback: a store that cannot open a transaction omits it, and
  // `settleRun` then makes the two writes the way this lane always has (settle, then stamp — awaited, and
  // swallowed by the caller). Missing this method must never mean a missing stamp.
  settleWith?(
    id: string,
    patch: Partial<RunRecord>,
    events: OutboxEvent[] | undefined,
    guard: RunUpdateGuard,
    // ── EVERY RIDER IS OPTIONAL, BECAUSE THE SEAM IS CHOSEN BY THE EFFECT (arch-review 71 P1) ────────
    //
    // `stamp` was required, so the caller that chose this path had to have one — and the seam's predicate was
    // written to match (`if (opts.stamp && store.settleWith)`). The standalone cancel has a RELEASE and no
    // stamp, so it silently took the non-transactional path and its release was dropped on the floor: the fix
    // for the cleanup leak was inert on every deployment with a real Postgres, one wave after it shipped.
    //
    // Both riders are optional now and the seam asks whether ANY of them is present.
    stamp?: AttemptStamp,
    // …and the intermediates this settlement frees, flipped in the SAME transaction (arch-review 70 P1).
    release?: CleanupRelease,
  ): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  list(tenant?: string, opts?: RunListOptions): Promise<RunRecord[]>;
  // Child-run counts per (batch, status) for the given batches, in ONE read — see `RunChildStatusCount`.
  // An empty `scorecardIds` answers `[]`; a batch with no children simply contributes no rows.
  countChildrenByStatus(tenant: string, scorecardIds: readonly string[]): Promise<RunChildStatusCount[]>;
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
