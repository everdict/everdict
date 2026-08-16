import type { RunRecord, ScorecardRecord } from "@everdict/contracts";
import type { AttemptStamp, OutboxEvent, RunStore, RunUpdateGuard } from "./run-store.js";
import { ABORTABLE_SETTLE_STATUSES, type ScorecardStore, type SettleOptions } from "./scorecard-store.js";

// ── THE TERMINAL VERB ────────────────────────────────────────────────────────────────────────────────
//
// Five reviews found a settlement written with its fence forgotten, in a different place each time, and each
// fix was the same line added to one more caller. That is an API problem wearing a discipline problem's
// clothes: a condition every caller must remember is a condition some caller will not.
//
// These cannot be called without the fence, because there is no parameter to leave out. The store applies it;
// the caller's only choice is WHICH settlement this is.
//
// A pair of functions rather than a method on the port, deliberately. The guarantee is identical — the fence
// lives in exactly one place either way — and a port method would force every hand-rolled fake in the
// repository to grow an implementation of it, which is how a small invariant turns into a large diff nobody
// reads. The port stays the minimum a store must answer for; the RULE lives beside it.
//
// Both return the settled record or `undefined` when the fence refused, and the caller must read that:
// publishing the settlement's facts, tearing down its work, dispatching more of it and seeding an aggregate
// from it are all authority the COMMITTED transition owns. Four of those five reviews found something acting
// on the attempt instead.

// The batch's outcome. `over` says which settlement:
//   "open"    — the ordinary one. Refuses a record that already settled (first terminal write wins).
//   "aborted" — `settleAborted`'s shape: it attaches a cancelled or superseded batch's partials on purpose,
//               and must never land on one that settled succeeded/failed. The domain says exactly this; the
//               store repeats it because the domain guard runs in one process and the race is in another.
// `epoch` is the driver's fencing token when it holds one (mig 0166) — absent means a record nobody claimed,
// which is a single-replica install rather than a weaker guarantee.
export async function settleScorecard(
  store: ScorecardStore,
  id: string,
  patch: Partial<ScorecardRecord>,
  events: OutboxEvent[] | undefined,
  opts: SettleOptions,
): Promise<ScorecardRecord | undefined> {
  return store.update(id, patch, events, {
    ...(opts.over === "aborted" ? { expectStatusIn: ABORTABLE_SETTLE_STATUSES } : { expectNonTerminal: true as const }),
    ...(opts.epoch !== undefined ? { expectOwnerEpoch: opts.epoch } : {}),
    ...(opts.expectReceiptCount !== undefined ? { expectReceiptCount: opts.expectReceiptCount } : {}),
    ...(opts.requestCancellation === true ? { requestCancellation: true as const } : {}),
  });
}

// A run's outcome. `epoch` is the driver's fencing token (mig 0170), and it is the value the settler HELD —
// captured when it dispatched, never re-read here, because a displaced driver re-reading would find its
// usurper's number and pass. `expectOwnerReplica` rides along for the recovery claim, a settlement of
// ownership rather than of outcome and the one place both conditions are asked at once.
export async function settleRun(
  store: RunStore,
  id: string,
  patch: Partial<RunRecord>,
  events?: OutboxEvent[],
  opts?: {
    expectOwnerReplica?: string | null;
    epoch?: number;
    // For a batch's CHILD: the parent's driver, proved inside this write. A child's own epoch is not a
    // stand-in — a parent takeover raises the SCORECARD's token and leaves the child's untouched, so a
    // displaced batch driver clears the child fence it was never displaced from (arch-review 33 P0).
    parentDriver?: { scorecardId: string; epoch: number };
    // The physical attempt's terminal stamp, made part of THIS settlement (arch-review 45). Offered rather
    // than commanded: a store with the atomic seam commits the two writes together, and one without it is
    // routed back to the ordinary settlement — so the caller that offers a stamp still owes the two-step
    // where the seam is absent (`RunService.finalize` owns that fallback, and the swallow that goes with it).
    stamp?: AttemptStamp;
    // THE CANCEL'S OWED TEARDOWN, committed with the decision (arch-review 52, Wave 3) — the run-scale twin
    // of `settleScorecard`'s option above. See `RunUpdateGuard.requestCancellation`.
    requestCancellation?: true;
  },
): Promise<RunRecord | undefined> {
  const guard: RunUpdateGuard = {
    expectNonTerminal: true,
    ...(opts?.requestCancellation === true ? { requestCancellation: true as const } : {}),
    ...(opts?.expectOwnerReplica !== undefined ? { expectOwnerReplica: opts.expectOwnerReplica } : {}),
    ...(opts?.epoch !== undefined ? { expectOwnerEpoch: opts.epoch } : {}),
    ...(opts?.parentDriver !== undefined ? { parentDriver: opts.parentDriver } : {}),
  };
  // One fence, two ways to commit it — the condition above is built once so the atomic path can never be
  // guarded more weakly than the ordinary one (which is how five reviews' worth of forgotten fences happened).
  if (opts?.stamp !== undefined && store.settleWith !== undefined)
    return store.settleWith(id, patch, events, guard, opts.stamp);
  return store.update(id, patch, events, guard);
}
