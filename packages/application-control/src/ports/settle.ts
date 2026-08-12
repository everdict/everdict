import type { RunRecord, ScorecardRecord } from "@everdict/contracts";
import type { OutboxEvent, RunStore } from "./run-store.js";
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
  opts?: { expectOwnerReplica?: string | null; epoch?: number },
): Promise<RunRecord | undefined> {
  return store.update(id, patch, events, {
    expectNonTerminal: true,
    ...(opts?.expectOwnerReplica !== undefined ? { expectOwnerReplica: opts.expectOwnerReplica } : {}),
    ...(opts?.epoch !== undefined ? { expectOwnerEpoch: opts.epoch } : {}),
  });
}
