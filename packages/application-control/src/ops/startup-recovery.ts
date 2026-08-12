import type { RunRecord } from "@everdict/contracts";
import type { ReplicaRegistry } from "../ports/replica-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { settleRun, settleScorecard } from "../ports/settle.js";

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

export interface RecoveryDeps {
  scorecards: ScorecardStore;
  runs?: RunStore;
  // ScorecardService.resume — re-drive an interrupted batch from its finished child results. Returns false when the
  // record can't be resumed (then we tombstone). Optional so recovery still works in stores-only wiring/tests.
  resume?: (id: string) => Promise<boolean>;
  // RunService.resume (adopt-first) — re-drive an interrupted STANDALONE run (adopt the still-alive backend job
  // or re-dispatch from the persisted caseSpec). false = legacy record → tombstone as before.
  resumeRun?: (record: RunRecord) => Promise<boolean>;
  // WHO this process is. Records it claims are re-stamped with it; records already stamped with it are ours to
  // reclaim (a replica whose identity is pinned across restarts must still recover its own interrupted work).
  owner?: string;
  // Which control planes are alive. Absent = the single-process assumption, i.e. every in-flight record is an
  // orphan — exactly the previous behavior.
  replicas?: ReplicaRegistry;
  now?: () => string;
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
    }
    if (deps.resume && (await deps.resume(c.id).catch(() => false))) {
      resumedCount += 1;
      continue; // resume re-dispatches unfinished cases and supersedes mid-flight children itself
    }
    // The tombstone that motivated the fence: a batch that settled while this recovery was deciding must not
    // be recorded as an infrastructure failure. `undefined` = it settled; nothing here is ours to write.
    const tombstoned = await settleScorecard(
      deps.scorecards,
      c.id,
      { status: "failed", error: INTERRUPTED, updatedAt: now() },
      undefined,
      { over: "open" },
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
      const settled = await settleRun(deps.runs, child.id, {
        status: "failed",
        error: INTERRUPTED,
        updatedAt: now(),
      });
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
      if (claim) {
        const claimed = await deps.runs.update(r.id, claim, undefined, {
          expectNonTerminal: true,
          expectOwnerReplica: r.ownerReplica ?? null,
        });
        if (claimed === undefined) {
          liveCount += 1; // settled, or claimed by another replica — either way not ours to drive
          continue;
        }
      }
      if (deps.resumeRun && (await deps.resumeRun(r).catch(() => false))) {
        runsResumed += 1;
        continue;
      }
      const settled = await settleRun(deps.runs, r.id, {
        status: "failed",
        error: INTERRUPTED,
        updatedAt: now(),
      });
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
