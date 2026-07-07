import type { RunStore, ScorecardStore } from "@everdict/db";

// Reclaim orphaned work on boot — batches (scorecards) and runs are tracked in-process inside the control-plane process
// (the single-process assumption, same as inFlight supersede / in-process rendezvous). So when the process restarts, the
// queued/running records the previous process was driving become ghosts with no owner to resume them — the cause of the
// queue/status showing "running" forever. At boot we finalize these as failed (INTERRUPTED) so the state matches reality.
// Note: if more than one control plane shares the same store (DB), this also reclaims another's in-flight work — we simply
// follow the single-control-plane assumption (common across the codebase).

const INTERRUPTED = {
  code: "INTERRUPTED",
  message: "The run was interrupted by a control-plane restart. Please run it again.",
};

const ACTIVE = new Set(["queued", "running"]);

export interface RecoveryDeps {
  scorecards: ScorecardStore;
  runs?: RunStore;
  now?: () => string;
}

export async function recoverInterrupted(deps: RecoveryDeps): Promise<{ scorecards: number; runs: number }> {
  const now = deps.now ?? (() => new Date().toISOString());
  let scorecardCount = 0;
  let runCount = 0;

  // ① Orphaned batches + the running child runs of those batches.
  const cards = (await deps.scorecards.list()).filter((c) => ACTIVE.has(c.status));
  for (const c of cards) {
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
  if (deps.runs) {
    const runs = (await deps.runs.list()).filter((r) => ACTIVE.has(r.status));
    for (const r of runs) {
      await deps.runs.update(r.id, { status: "failed", error: INTERRUPTED, updatedAt: now() });
      runCount += 1;
    }
  }

  return { scorecards: scorecardCount, runs: runCount };
}
