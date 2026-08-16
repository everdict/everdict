// ── WHAT A STOP ACTUALLY ACHIEVED (arch-review 52, Wave 3) ───────────────────────────────────────────
//
// Every teardown path in the system asked a backend to stop something and then reported the cancellation
// done. `kill` and `killWork` returned `Promise<void>` and swallowed their own failures ("best-effort,
// never throws"), so "the command returned" and "the allocation stopped" were the same observation — and
// the composition root then wrapped them in `.catch(() => {})`, which made even a rejection unobservable.
// The one caller written to treat a failed teardown as its own failure could therefore never see one: it
// awaited an arm that resolved cleanly while the cluster job kept running. Cancellation certified a
// teardown that had not happened, and every later reader agreed the compute was freed.
//
// A stop has four honest answers and the difference between them is the whole point:
//   stopped — the orchestrator accepted the delete and the object is going away. Converged.
//   absent  — there was nothing there to stop (already finished, already deleted, never placed on this
//             cluster). Converged: the postcondition "this work is not running" holds.
//   unknown — the call could not establish either. A listing that failed, a cluster that answered
//             something unparseable. The work is PROBABLY still running, which is why this is not `absent`.
//   failed  — the orchestrator refused or could not be reached. The work is almost certainly still running.
//
// Only the first two are convergence. `unknown` and `failed` mean the teardown is still OWED, and the
// cancellation ledger keeps it that way until a sweep gets a converged answer.
export type KillOutcomeStatus = "stopped" | "absent" | "unknown" | "failed";

export interface KillOutcome {
  status: KillOutcomeStatus;
  // Why, for the non-converged answers — an operator diagnostic and the `lastError` a cancellation
  // operation carries. Never an input to whether the teardown is retried: `status` alone decides that.
  reason?: string;
}

// Has this stop reached its postcondition? The one question every caller actually asks, in one place, so
// "unknown counts as converged" cannot be re-decided differently in four teardowns.
export function killConverged(outcome: KillOutcome): boolean {
  return outcome.status === "stopped" || outcome.status === "absent";
}

// Severity order for aggregation. `absent` sits BELOW `stopped` deliberately: both converge, and when a
// fan-out over several clusters produces one of each, "we stopped it" is the more informative report.
const SEVERITY: Record<KillOutcomeStatus, number> = { absent: 0, stopped: 1, unknown: 2, failed: 3 };

// Aggregate a fan-out (one runtime lane's shard list, one run's several work handles) into the single
// answer its caller must act on: THE WORST ONE. A teardown that stopped three jobs and could not reach the
// fourth has not converged, and reporting the majority verdict is how live compute gets certified as freed.
//
// An EMPTY fan-out is `absent`, not `stopped`: nothing was asked, so nothing was confirmed stopped — but
// nothing is known to be running either, which is exactly what `absent` means (a runtime lane that resolved
// to no killable backend, e.g. a self-hosted lease queue, has no orchestrator object to leave behind).
export function worstKillOutcome(outcomes: readonly KillOutcome[]): KillOutcome {
  let worst: KillOutcome = { status: "absent" };
  for (const outcome of outcomes) if (SEVERITY[outcome.status] > SEVERITY[worst.status]) worst = outcome;
  return worst;
}
