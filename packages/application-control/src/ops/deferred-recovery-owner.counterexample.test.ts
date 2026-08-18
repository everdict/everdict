import { describe, expect, it } from "vitest";
import type { ResumeResult } from "../run/run-service.js";
import { recoverInterrupted, retryDeferredRecovery } from "./startup-recovery.js";

// ── A DEBT NOBODY OWNS IS NOT DEFERRED, IT IS DROPPED (arch-review 56, Wave C) ───────────────────────
//
// Review 55 gave boot recovery a third answer. A batch whose attempt ledger could not be read is no longer
// tombstoned as `failed{INTERRUPTED}`; it is left open, and the code says so:
//
//     // LEFT AS IT IS, deliberately: claimed by this replica, still open, and NOT counted as recovered. The
//     // next sweep asks again. Writing anything terminal here is the defect this case exists to prevent.
//
// There is no next sweep. `runStartupRecovery` is awaited ONCE at boot; the periodic reconcilers registered
// beside it are the cancellation and publication ones. So the comment promises another component's behaviour
// and that component does not exist — the same shape as R55.1 ("the caller treats a throw as not resumable")
// and R55.6 ("the operation stays owed"), which is why it is now a rule rather than a lesson.
//
// What the deferral leaves behind is worse than a stale row, because the claim ran FIRST: the record is
// `running`, `ownerReplica` is a LIVE replica, and its epoch was raised. Every other replica's recovery reads
// exactly that as "somebody is driving this" and steps around it. The batch has an owner, a fence and no
// driver, until the owning process restarts.
//
// The fix is L5's own sentence — a debt owns its worklist. The deferral is not a counter, it is a list of
// targets this replica still owes an answer for, and the owner is the one that must retry: it is the only
// process the record's own ownership permits to act.

type Target = { kind: "scorecard" | "run"; id: string };

// A world whose ledger is unreadable on the first pass and readable afterwards — the ordinary shape of the
// transient failure `retry_later` was introduced for.
function world(failFirst: number) {
  let attempts = 0;
  const record = {
    id: "sc-1",
    tenant: "acme",
    status: "running",
    ownerEpoch: 1,
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  } as Record<string, unknown>;
  const scorecards = {
    async list() {
      return [record];
    },
    async get() {
      return record;
    },
    async update(_id: string, patch: Record<string, unknown>) {
      Object.assign(record, patch);
      return record;
    },
  };
  return {
    record,
    resumes: () => attempts,
    deps: {
      scorecards: scorecards as never,
      owner: "replica-1",
      replicas: {
        async liveReplicas() {
          return ["replica-1"];
        },
      } as never,
      now: () => "2026-08-18T00:00:01.000Z",
      resume: async (): Promise<ResumeResult> => {
        attempts += 1;
        return attempts <= failFirst
          ? { kind: "retry_later", reason: "the attempt ledger is unreachable" }
          : { kind: "resumed" };
      },
    },
  };
}

// RED as of 297c090f, observed:
//   nothing names what this sweep still owes an answer for: expected undefined to deeply equal
//   [ { kind: 'scorecard', id: 'sc-1' } ]
describe("[R56 WAVE-C COUNTEREXAMPLE #4 — CLOSED] a deferred recovery is owed by somebody", () => {
  it("names the records it deferred, not just how many", async () => {
    const w = world(1);
    const outcome = await recoverInterrupted(w.deps as never);

    expect(outcome.deferred, "the counter says 1 and nothing says WHICH").toBe(1);
    expect(
      (outcome as { owed?: Target[] }).owed,
      "nothing names what this sweep still owes an answer for, so nothing can retry it",
    ).toEqual([{ kind: "scorecard", id: "sc-1" }]);
  });

  it("retries exactly that worklist without a process restart, and converges", async () => {
    const w = world(1);
    const first = await recoverInterrupted(w.deps as never);
    const owed = (first as { owed?: Target[] }).owed ?? [];

    // The sweep the comment promised, as a function somebody can actually register.
    const stillOwed = await retryDeferredRecovery(w.deps as never, owed);

    expect(w.resumes(), "the deferred record was never asked again").toBe(2);
    expect(stillOwed, "a record that resumed is still on the worklist").toEqual([]);
    expect(w.record.status).toBe("running"); // resumed, never tombstoned
  });

  it("keeps a record that defers AGAIN on the worklist rather than deciding about it", async () => {
    // The convergence question. A retry that gave up would be the tombstone this whole union exists to
    // prevent, one loop later; a retry that dropped the item would be the current defect with more steps.
    const w = world(5);
    const first = await recoverInterrupted(w.deps as never);
    let owed = (first as { owed?: Target[] }).owed ?? [];
    owed = await retryDeferredRecovery(w.deps as never, owed);

    expect(owed, "a still-unreadable ledger dropped the debt instead of keeping it").toEqual([
      { kind: "scorecard", id: "sc-1" },
    ]);
    expect(w.record.status, "the retry wrote a terminal row over a transient failure").toBe("running");
  });

  it("retries only what was deferred — never everything this replica owns", async () => {
    // The reason boot recovery is not simply re-run on a timer: it claims and resumes every ACTIVE record
    // whose owner is not another live replica, which after boot includes every batch THIS replica is
    // actively driving. Re-running it periodically would re-dispatch live work.
    const w = world(0);
    const stillOwed = await retryDeferredRecovery(w.deps as never, []);
    expect(w.resumes(), "an empty worklist still touched a record").toBe(0);
    expect(stillOwed).toEqual([]);
  });
});
