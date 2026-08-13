import type { RunRecord } from "@everdict/contracts";
import type { ReplicaRegistry } from "../ports/replica-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { settleRun, settleScorecard } from "../ports/settle.js";
import { tombstoneInterrupted } from "./tombstone.js";

// Reclaim orphaned work on boot — batches (scorecards) and runs are tracked in-process inside the control-plane process
// (the single-process assumption, same as inFlight supersede / in-process rendezvous). So when the process restarts, the
// queued/running records the previous process was driving become ghosts with no owner to resume them.
//
// Batches are RESUMED, not tombstoned (docs/architecture/batch-resilience.md): results persist per case (child runs),
// so an interrupted batch re-drives only its unfinished cases via the injected `resume`. Records that can't be
// faithfully resumed (pre-orchestration records, unresolvable dataset) fall back to the old failed(INTERRUPTED)
// tombstone so the state still matches reality. Standalone runs are resumed too (P4 single-run durability): adopt the
// still-alive backend job's result, else re-dispatch from the persisted caseSpec (mig 0051); legacy records tombstone.
//
// MORE THAN ONE control plane may share this store (docs/architecture/multi-replica.md), and then "in flight" no
// longer means "orphaned": the record may belong to a replica that is very much alive. So a record is reclaimed
// only when its owner is GONE — `ownerReplica` (stamped by the store that wrote it) is checked against the live
// heartbeat set, and a record with no owner (pre-column rows, the in-memory store) keeps the old unconditional
// behavior. A record this replica does claim is re-stamped as ours, so the NEXT boot doesn't take it back from us.

// Exported so the composition's BACKGROUND resume leg can apply the same tombstone when a claimed resume
// turns out to be impossible — a claim that fails silently leaves the record `running` forever (the exact
// zombie this sweep exists to prevent).
export const INTERRUPTED = {
  code: "INTERRUPTED",
  message: "The run was interrupted by a control-plane restart. Please run it again.",
};

const ACTIVE = new Set(["queued", "running"]);
// "we could not read who is alive" — distinct from "nobody is alive", which would clear every owned record.
const UNKNOWN = "unknown" as const;

// WHAT A RECOVERY WON, as a value it carries rather than a state it looks up. `epoch` is the fencing token
// the claim raised; every write that drives the record proves it. Re-reading it from the row is the one thing
// that must never happen — the number there a moment later belongs to whoever displaced this replica.
export interface DriverAuthority {
  readonly ownerReplica: string;
  readonly epoch: number;
}

export interface RecoveryDeps {
  scorecards: ScorecardStore;
  runs?: RunStore;
  // ScorecardService.resume — re-drive an interrupted batch from its finished child results. Returns false when the
  // record can't be resumed (then we tombstone). Optional so recovery still works in stores-only wiring/tests.
  //
  // THE AUTHORITY TRAVELS AS AN ARGUMENT (arch-review 32 P0). It used to take an id, and everything
  // downstream re-read the record to find out which epoch it was driving under — which is not a fencing
  // token, it is a lease check wearing one's clothes. Three replicas are enough to show why: B claims (epoch
  // 1) and pauses, C claims (epoch 2) and starts driving, B wakes, re-reads, adopts C's OWN token and drives
  // beside it. Nobody had to win a race; B only had to read.
  resume?: (id: string, authority: DriverAuthority) => Promise<boolean>;
  // RunService.resume (adopt-first) — re-drive an interrupted STANDALONE run (adopt the still-alive backend job
  // or re-dispatch from the persisted caseSpec). false = legacy record → tombstone as before.
  resumeRun?: (record: RunRecord, authority: DriverAuthority) => Promise<boolean>;
  // WHO this process is. Records it claims are re-stamped with it; records already stamped with it are ours to
  // reclaim (a replica whose identity is pinned across restarts must still recover its own interrupted work).
  owner?: string;
  // Which control planes are alive. Absent = the single-process assumption, i.e. every in-flight record is an
  // orphan — exactly the previous behavior.
  replicas?: ReplicaRegistry;
  now?: () => string;
  // Fact identity for the tombstones this sweep writes (a terminal row that told nobody is how a completion
  // callback goes missing — see `tombstoneInterrupted`). Absent in stores-only wiring/tests.
  newId?: () => string;
}

export async function recoverInterrupted(deps: RecoveryDeps): Promise<{
  scorecards: number;
  resumed: number;
  runs: number;
  runsResumed: number;
  sessions: number;
  // Records left alone because another replica is still driving them — the difference between a control plane
  // that scales and one that eats its own work at every boot.
  live: number;
}> {
  const now = deps.now ?? (() => new Date().toISOString());
  // The clock + fact identity the tombstones write under (see `tombstoneInterrupted`).
  const clock = { now, newId: deps.newId ?? (() => `evt-${Math.random().toString(36).slice(2)}`) };
  let scorecardCount = 0;
  let resumedCount = 0;
  let runCount = 0;
  let liveCount = 0;

  // A store hiccup here must not turn into "reclaim everything" — an unreadable heartbeat set means we cannot
  // prove anybody is dead, so with a registry wired we treat every OWNED record as still driven (fail-closed:
  // leaving a stale record for the next boot is recoverable, killing a live batch is not).
  const live = deps.replicas ? await deps.replicas.liveReplicas().catch(() => UNKNOWN) : [];
  const drivenByAnother = (ownerReplica: string | undefined): boolean =>
    ownerReplica !== undefined && ownerReplica !== deps.owner && (live === UNKNOWN || live.includes(ownerReplica));
  // Taking a record over means becoming its driver — otherwise the next boot reads the dead owner and reclaims
  // work this replica is now driving.
  const claim = deps.owner === undefined ? undefined : { ownerReplica: deps.owner };

  // ① Orphaned batches — resume when possible; tombstone (plus their still-active children) when not.
  const cards = (await deps.scorecards.list()).filter((c) => ACTIVE.has(c.status));
  for (const c of cards) {
    if (drivenByAnother(c.ownerReplica)) {
      liveCount += 1;
      continue;
    }
    // What this recovery is entitled to do to this batch. Replaced by the CLAIM's own answer below when a
    // claim is made; with no owner configured (single-process wiring) it is the record's own epoch, which is
    // the same value nobody else is racing for.
    let authority: DriverAuthority = { ownerReplica: deps.owner ?? UNKNOWN, epoch: c.ownerEpoch ?? 0 };
    // THE CLAIM IS THE AUTHORITY (arch-review 28 P1). Two control planes booting together both see this
    // batch's owner gone, and without an exclusive claim both stamped themselves and both resumed — the
    // child terminal CAS keeps the ROWS honest and does nothing about two replicas dispatching the same
    // unfinished cases. Ownership and the right to drive the work are one transition.
    //
    // The claim conditions on the owner the recovery OBSERVED, so exactly one replica wins; the loser is not
    // this batch's recovery and does not touch it further.
    if (claim) {
      const claimed = await deps.scorecards.update(c.id, claim, undefined, {
        expectOwnerReplica: c.ownerReplica ?? null,
        // …and still OPEN (arch-review 29 P0). The owner condition asks "is the dead replica still the
        // owner", which stays true after the work finished — so without this a batch that succeeded between
        // the list and here was claimed, failed to resume (it is already done), and got tombstoned below.
        expectNonTerminal: true,
        // …and the claim RAISES the fencing token in the same statement (mig 0166). The replica this
        // recovery declared dead may be paused rather than gone, with its execution loop intact; identity
        // alone never reaches that process, and a number that moved under its next write does.
        claimOwnership: true,
      });
      if (claimed === undefined) {
        liveCount += 1; // another replica claimed it — its recovery, not ours
        continue;
      }
      // The token this recovery WON. Carried from here to every write that drives the batch; never looked up
      // again, because the value in the row a minute from now is whoever displaced us.
      authority = { ownerReplica: deps.owner ?? UNKNOWN, epoch: claimed.ownerEpoch ?? 0 };
    }
    if (deps.resume && (await deps.resume(c.id, authority).catch(() => false))) {
      resumedCount += 1;
      continue; // resume re-dispatches unfinished cases and supersedes mid-flight children itself
    }
    // The tombstone that motivated the fence: a batch that settled while this recovery was deciding must not
    // be recorded as an infrastructure failure. `undefined` = it settled; nothing here is ours to write.
    // …UNDER THE EPOCH THIS RECOVERY HOLDS (arch-review 32 P0). Without it, a replica that lost the batch to
    // a later takeover could still tombstone the OPEN batch its successor is driving: `expectNonTerminal`
    // says the row is open, which is exactly what makes it the successor's to finish.
    const tombstoned = await settleScorecard(
      deps.scorecards,
      c.id,
      { status: "failed", error: INTERRUPTED, updatedAt: now() },
      undefined,
      { over: "open", epoch: authority.epoch },
    );
    if (tombstoned === undefined) {
      liveCount += 1;
      continue;
    }
    scorecardCount += 1;
    if (!deps.runs) continue;
    const children = await deps.runs.list(c.tenant, { scorecardId: c.id });
    for (const child of children) {
      if (!ACTIVE.has(child.status)) continue;
      // …under the settle CAS (arch-review 26 P1). A booting replica reclaiming a dead one's work reads a
      // snapshot; a late drain, a self-hosted runner reporting in, or the dying process's own last write can
      // land between that read and this one. Marking such a child INTERRUPTED would erase a real outcome.
      // Through the DOMAIN transition, so the tombstone emits the terminal fact a normal failure emits
      // (arch-review 34 P1) — a row nobody was told about is how a completion callback goes missing for
      // exactly the runs a recovery is cleaning up.
      const settled = await tombstoneInterrupted(deps.runs, child, clock, { epoch: child.ownerEpoch ?? 0 });
      if (settled) runCount += 1;
    }
  }

  // ② Orphaned standalone runs (the activity-list default scope — children are reclaimed via their parent in ①).
  // RESUMED when possible (adopt the still-alive backend job / re-dispatch from the persisted caseSpec);
  // tombstoned only for legacy records with no persisted case.
  let runsResumed = 0;
  let sessionCount = 0;
  if (deps.runs) {
    const runs = (await deps.runs.list()).filter((r) => ACTIVE.has(r.status));
    for (const r of runs) {
      // Session runs (held-open compute: sandbox shells, worlds, browsers) are NOT resumable work — there is
      // no caseSpec to re-drive and no backend job to adopt, so the old path "resumed" them into a permanent
      // `running` row (the zombie this sweep is named after). Their lifecycle belongs to the session lanes'
      // own reapers: the durable reaper fires at the row's deadline, and the ledger orphan sweep
      // (SandboxSessionService.sweepOrphans / the browser equivalent) settles any row whose timer was lost.
      if (r.kind === "sandbox") {
        sessionCount += 1;
        continue;
      }
      // Another replica is still driving this run — its result is coming, and settling it here would tombstone
      // work that is about to succeed.
      if (drivenByAnother(r.ownerReplica)) {
        liveCount += 1;
        continue;
      }
      // The same claim, for a standalone run: still open AND still owned by the replica this recovery saw.
      // `expectNonTerminal` alone said "the run is open", which is true for both racing replicas — it is not
      // an answer to "may I take it" (arch-review 28 P1).
      // The claim ALSO raises the run's fencing token (arch-review 31 P1, mig 0170), and the resume is driven
      // from the record the claim RETURNED rather than the one the list read. The distinction is the whole
      // mechanism: the returned record carries the epoch this replica won, and every write that drives the
      // run proves that number — so the replica this recovery declared dead, if it was only paused, fails
      // against a value that moved instead of settling a run it no longer owns.
      let driving = r;
      let runAuthority: DriverAuthority = { ownerReplica: deps.owner ?? UNKNOWN, epoch: r.ownerEpoch ?? 0 };
      if (claim) {
        const claimed = await deps.runs.update(r.id, claim, undefined, {
          expectNonTerminal: true,
          expectOwnerReplica: r.ownerReplica ?? null,
          claimOwnership: true,
        });
        if (claimed === undefined) {
          liveCount += 1; // settled, or claimed by another replica — either way not ours to drive
          continue;
        }
        driving = claimed;
        runAuthority = { ownerReplica: deps.owner ?? UNKNOWN, epoch: claimed.ownerEpoch ?? 0 };
      }
      if (deps.resumeRun && (await deps.resumeRun(driving, runAuthority).catch(() => false))) {
        runsResumed += 1;
        continue;
      }
      // …and the same transition here, under the epoch this recovery claimed: a replica displaced by a later
      // takeover must not tombstone the open run its successor is now driving.
      const settled = await tombstoneInterrupted(deps.runs, r, clock, { epoch: runAuthority.epoch });
      if (settled) runCount += 1;
    }
  }
  return {
    scorecards: scorecardCount,
    resumed: resumedCount,
    runs: runCount,
    runsResumed,
    sessions: sessionCount,
    live: liveCount,
  };
}
