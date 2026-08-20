import type { RunRecord } from "@everdict/contracts";
import type { ReplicaRegistry } from "../ports/replica-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { settleRun, settleScorecard } from "../ports/settle.js";
import type { ResumeResult } from "../run/run-service.js";
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
  //
  // IT ANSWERS FOUR WAYS, NOT TWO (arch-review 55). It returned `boolean`, and the sweep read `false` as
  // "tombstone this as INTERRUPTED". Every failure downstream — a dataset that no longer resolves, an
  // attempt ledger that could not be read, a cluster that would not say whether a job is live — funnelled
  // through one `.catch(() => false)` into that single branch. So a transient outage was recorded as a
  // permanently failed evaluation, over managed jobs that were still running.
  resume?: (id: string, authority: DriverAuthority) => Promise<ResumeResult>;
  // RunService.resume (adopt-first) — re-drive an interrupted STANDALONE run (adopt the still-alive backend job
  // or re-dispatch from the persisted caseSpec). false = legacy record → tombstone as before.
  resumeRun?: (record: RunRecord, authority: DriverAuthority) => Promise<ResumeResult>;
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

// WHAT A DEFERRED RECOVERY STILL OWES (arch-review 56, Wave C). A target, not a count — see `owed` above.
export interface RecoveryTarget {
  kind: "scorecard" | "run";
  id: string;
  // ── THE CAPABILITY THE CLAIM ISSUED, CARRIED (arch-review 57 P0) ────────────────────────────────
  //
  // A worklist entry used to be identity alone, and the retry rebuilt an authority when it fired: this
  // process's replica id combined with whatever epoch the ROW held by then. That is not re-presenting a
  // capability, it is minting one out of the successor's — a replica displaced while its retry was pending
  // woke up, read the new owner's generation, and drove the batch with it. The write fence compares
  // `expectOwnerEpoch` alone, so it was accepted.
  //
  // A fencing token is issued BY a claim TO an owner. It is not a version number to be looked up, which is
  // exactly the confusion that made this reachable, so the token travels with the debt.
  authority: DriverAuthority;
  // ── WHY THIS IS STILL OWED, AND FOR HOW LONG (arch-review 58, W4) ────────────────────────────
  //
  // `retry_later` carries a REASON — "the attempt ledger would not answer", "the cluster did not say
  // whether the job is live" — and every one of the four places that consumed it dropped the string and kept
  // only the target. So a debt could sit in the worklist forever with nothing anywhere saying why, which is
  // precisely the state rule `protocol` L5 says must be an ESCALATION rather than a quiet hold: "we could
  // not find out" is an escalation field (attempts, backoff, operator alert), never a terminal state and
  // never a silence.
  //
  // `attempts` counts the passes that could not decide; `lastReason` is what the last one said. A target on
  // its first deferral is ordinary; one on its fiftieth is an operator's problem, and the difference is now
  // visible instead of being a number nobody kept.
  attempts: number;
  lastReason?: string;
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
  // Records THIS sweep claimed and could not decide about — an unreadable ledger, a cluster that would not
  // answer. Left open and untouched. Distinct from `live` (somebody else owns it) and from
  // `scorecards`/`runs` (we wrote a terminal row): those two were the only answers the boolean boundary had,
  // and this one is what it was missing (arch-review 55).
  deferred: number;
  // …AND WHICH ONES (arch-review 56, Wave C). The count said "we deferred 3" and nothing said which three, so
  // the comment beside the deferral — "the next sweep asks again" — described a component that did not exist:
  // boot recovery runs ONCE, and the periodic reconcilers beside it are the cancellation and publication ones.
  //
  // What the deferral leaves behind is not a stale row. The claim ran first, so the record is open, owned by a
  // LIVE replica and fenced at a raised epoch — which every other replica's recovery correctly reads as
  // "somebody is driving this" and steps around. An owner, a fence, and no driver.
  //
  // So the debt owns its worklist (L5). These are the targets this replica still owes an answer for, retried
  // by `retryDeferredRecovery` — and only these: re-running the whole sweep on a timer would re-claim and
  // re-resume every ACTIVE record this replica is currently DRIVING, which is re-dispatching live work.
  //
  // Durable across a crash without a new store: a process that dies stops heartbeating, and the next
  // replica's boot recovery finds the record with a dead owner and reclaims it. The worklist is what closes
  // the gap while the owner is still alive, which is the case nothing covered.
  owed: RecoveryTarget[];
}> {
  const now = deps.now ?? (() => new Date().toISOString());
  // The clock + fact identity the tombstones write under (see `tombstoneInterrupted`).
  const clock = { now, newId: deps.newId ?? (() => `evt-${Math.random().toString(36).slice(2)}`) };
  let scorecardCount = 0;
  let resumedCount = 0;
  let runCount = 0;
  let liveCount = 0;
  // Records this sweep could not DECIDE about — an unreadable ledger, a cluster that would not answer. Left
  // exactly as they are and reported separately, because "we deferred 3" and "we failed 3" are opposite
  // operational facts and the boolean boundary could only say the second (arch-review 55).
  let deferredCount = 0;
  const owed: RecoveryTarget[] = [];

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
    // An exception is "we could not find out" — the same answer as an explicit `retry_later`, and never a
    // reason to write a terminal row (rule `protocol` L2: never signal unknown by throwing, and never let a
    // catch answer for a decision).
    const disposition = deps.resume
      ? await deps.resume(c.id, authority).catch(
          (err: unknown): ResumeResult => ({
            kind: "retry_later",
            reason: err instanceof Error ? err.message : String(err),
          }),
        )
      : ({ kind: "unresumable" } as ResumeResult);
    // resume re-dispatches unfinished cases and supersedes mid-flight children itself.
    if (disposition.kind === "resumed" || disposition.kind === "already_settled") {
      resumedCount += 1;
      continue;
    }
    if (disposition.kind === "retry_later") {
      // LEFT AS IT IS, deliberately: claimed by this replica, still open, and NOT counted as recovered.
      // Writing anything terminal here is the defect this case exists to prevent — and the record is now on
      // THIS replica's worklist, because it is the only process the record's own ownership permits to act
      // (arch-review 56, Wave C: the previous version said "the next sweep asks again" and there was none).
      deferredCount += 1;
      // The capability THIS claim issued — not the row's current one, which is what the retry used to read.
      owed.push({
        kind: "scorecard",
        id: c.id,
        authority,
        attempts: 1,
        ...(disposition.kind === "retry_later" ? { lastReason: disposition.reason } : {}),
      });
      console.warn(`▶ boot recovery: batch ${c.id} left for a later sweep — ${disposition.reason}`);
      continue;
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
      const runDisposition = deps.resumeRun
        ? await deps.resumeRun(driving, runAuthority).catch(
            (err: unknown): ResumeResult => ({
              kind: "retry_later",
              reason: err instanceof Error ? err.message : String(err),
            }),
          )
        : ({ kind: "unresumable" } as ResumeResult);
      if (runDisposition.kind === "resumed" || runDisposition.kind === "already_settled") {
        runsResumed += 1;
        continue;
      }
      if (runDisposition.kind === "retry_later") {
        deferredCount += 1;
        owed.push({
          kind: "run",
          id: r.id,
          authority: runAuthority,
          attempts: 1,
          lastReason: runDisposition.reason,
        });
        console.warn(`▶ boot recovery: run ${r.id} left for a later sweep — ${runDisposition.reason}`);
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
    deferred: deferredCount,
    owed,
  };
}

// ── THE SWEEP THE DEFERRAL ALWAYS ASSUMED (arch-review 56, Wave C) ──────────────────────────────────
//
// Re-attempt exactly the targets a previous pass could not decide about, and answer with the ones that STILL
// cannot be decided. The caller registers it on a timer and feeds its own answer back in, so a transient
// ledger outage converges without a process restart and a persistent one keeps the debt visible instead of
// resolving it.
//
// Deliberately NOT `recoverInterrupted` on a timer. That function claims and resumes every ACTIVE record
// whose owner is not another live replica — which, after boot, is every batch this replica is currently
// DRIVING. Running it periodically would re-dispatch live work, which is why the retry is a worklist rather
// than a schedule.
//
// It never writes a terminal row. A target that defers again is returned, not decided about: the tombstone
// this union exists to prevent is exactly as wrong on the tenth attempt as on the first.
// Does the record still belong to the holder this debt was claimed by?
//
// The EPOCH is the load-bearing half, and on its own it is sufficient: the store issues `ownerEpoch + 1` per
// RECORD, so a given (record, generation) pair has exactly one holder for all time. Any takeover moves it,
// whether the successor is another replica or the same one restarted.
//
// The replica name is compared too, and it is REDUNDANT while that stays true — a mutation that drops it
// leaves every counterexample here green, which is the honest report. It is kept as a statement of what the
// token is (a capability issued BY a claim TO an owner, not a number read off a row) and as the check that
// would start mattering if generations ever became global rather than per-record. Nothing depends on it.
//
// UNCLAIMED is a state both sides can be in, and it has to compare equal. A deployment with no replica
// identity configured never claims — the sweep's authority is the `unknown`/0 sentinel and the row's owner
// columns stay NULL — so comparing the raw values would make every retry look displaced and discharge the
// whole worklist in silence. That is the single-replica path, i.e. every dev install.
function stillHolds(authority: DriverAuthority, record: { ownerReplica?: string; ownerEpoch?: number }): boolean {
  return (record.ownerReplica ?? UNKNOWN) === authority.ownerReplica && (record.ownerEpoch ?? 0) === authority.epoch;
}

export async function retryDeferredRecovery(
  deps: Pick<RecoveryDeps, "scorecards" | "runs" | "resume" | "resumeRun" | "owner" | "now">,
  owed: readonly RecoveryTarget[],
): Promise<RecoveryTarget[]> {
  const stillOwed: RecoveryTarget[] = [];
  for (const target of owed) {
    if (target.kind === "scorecard") {
      const record = await deps.scorecards.get?.(target.id);
      // Gone or settled by whoever finished it — the debt is discharged, and re-resuming would be the
      // takeover this whole file is written to avoid.
      if (!record || !ACTIVE.has(record.status)) continue;
      // The record is still ours by construction: this worklist only holds targets this replica claimed, and
      // a takeover raises the epoch so the resume below is refused rather than racing.
      // The row's ownership NOW, against the capability this target was claimed with. Different means this
      // replica was displaced: the batch has a live owner that is not us, so the debt is discharged rather
      // than retried — keeping it owed would have us asking forever about someone else's work.
      if (!stillHolds(target.authority, record)) continue;
      const authority = target.authority;
      const disposition = deps.resume
        ? await deps.resume(target.id, authority).catch(
            (err: unknown): ResumeResult => ({
              kind: "retry_later",
              reason: err instanceof Error ? err.message : String(err),
            }),
          )
        : ({ kind: "retry_later", reason: "no resume wired" } as ResumeResult);
      if (disposition.kind === "retry_later")
        stillOwed.push({ ...target, attempts: target.attempts + 1, lastReason: disposition.reason });
      continue;
    }
    const run = await deps.runs?.get?.(target.id);
    if (!run || !ACTIVE.has(run.status)) continue;
    if (!stillHolds(target.authority, run)) continue;
    const authority = target.authority;
    const disposition = deps.resumeRun
      ? await deps.resumeRun(run, authority).catch(
          (err: unknown): ResumeResult => ({
            kind: "retry_later",
            reason: err instanceof Error ? err.message : String(err),
          }),
        )
      : ({ kind: "retry_later", reason: "no resume wired" } as ResumeResult);
    if (disposition.kind === "retry_later")
      stillOwed.push({ ...target, attempts: target.attempts + 1, lastReason: disposition.reason });
  }
  return stillOwed;
}
