import type { RunRecord } from "@everdict/contracts";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";

// Reclaim orphaned work on boot — batches (scorecards) and runs are tracked in-process inside the control-plane process
// (the single-process assumption, same as inFlight supersede / in-process rendezvous). So when the process restarts, the
// queued/running records the previous process was driving become ghosts with no owner to resume them.
//
// Batches are RESUMED, not tombstoned (docs/architecture/batch-resilience.md): results persist per case (child runs),
// so an interrupted batch re-drives only its unfinished cases via the injected `resume`. Records that can't be
// faithfully resumed (pre-orchestration records, unresolvable dataset) fall back to the old failed(INTERRUPTED)
// tombstone so the state still matches reality. Standalone runs are resumed too (P4 single-run durability): adopt the
// still-alive backend job's result, else re-dispatch from the persisted caseSpec (mig 0051); legacy records tombstone.
// Note: if more than one control plane shares the same store (DB), this also reclaims another's in-flight work — we simply
// follow the single-control-plane assumption (common across the codebase).

// Exported so the composition's BACKGROUND resume leg can apply the same tombstone when a claimed resume
// turns out to be impossible — a claim that fails silently leaves the record `running` forever (the exact
// zombie this sweep exists to prevent).
export const INTERRUPTED = {
  code: "INTERRUPTED",
  message: "The run was interrupted by a control-plane restart. Please run it again.",
};

const ACTIVE = new Set(["queued", "running"]);

export interface RecoveryDeps {
  scorecards: ScorecardStore;
  runs?: RunStore;
  // ScorecardService.resume — re-drive an interrupted batch from its finished child results. Returns false when the
  // record can't be resumed (then we tombstone). Optional so recovery still works in stores-only wiring/tests.
  resume?: (id: string) => Promise<boolean>;
  // RunService.resume (adopt-first) — re-drive an interrupted STANDALONE run (adopt the still-alive backend job
  // or re-dispatch from the persisted caseSpec). false = legacy record → tombstone as before.
  resumeRun?: (record: RunRecord) => Promise<boolean>;
  now?: () => string;
}

export async function recoverInterrupted(
  deps: RecoveryDeps,
): Promise<{ scorecards: number; resumed: number; runs: number; runsResumed: number; sessions: number }> {
  const now = deps.now ?? (() => new Date().toISOString());
  let scorecardCount = 0;
  let resumedCount = 0;
  let runCount = 0;

  // ① Orphaned batches — resume when possible; tombstone (plus their still-active children) when not.
  const cards = (await deps.scorecards.list()).filter((c) => ACTIVE.has(c.status));
  for (const c of cards) {
    if (deps.resume && (await deps.resume(c.id).catch(() => false))) {
      resumedCount += 1;
      continue; // resume re-dispatches unfinished cases and supersedes mid-flight children itself
    }
    await deps.scorecards.update(c.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
    scorecardCount += 1;
    if (!deps.runs) continue;
    const children = await deps.runs.list(c.tenant, { scorecardId: c.id });
    for (const child of children) {
      if (!ACTIVE.has(child.status)) continue;
      await deps.runs.update(child.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
      runCount += 1;
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
      if (deps.resumeRun && (await deps.resumeRun(r).catch(() => false))) {
        runsResumed += 1;
        continue;
      }
      await deps.runs.update(r.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
      runCount += 1;
    }
  }
  return { scorecards: scorecardCount, resumed: resumedCount, runs: runCount, runsResumed, sessions: sessionCount };
}
