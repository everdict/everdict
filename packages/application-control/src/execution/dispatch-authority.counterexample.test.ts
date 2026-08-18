import type { RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, type OpenAttemptInput } from "../ports/execution-attempt-store.js";

// ── A PROOF HAS A LIFETIME (arch-review 55, Wave 1) ──────────────────────────────────────────────────
//
// Phase 1 made the reservation return proof that the handle was WRITTEN, and the backend refuse to submit
// without it. That closed "nobody recorded where this work is". It left open the question one layer over:
// was the caller still allowed to place work at all?
//
//     UPDATE everdict_execution_attempts SET runtime_work = $2 WHERE attempt_id = $1 RETURNING …
//
// The row exists, so the write succeeds — for an attempt that has been superseded, for a batch a takeover
// gave to another replica, for a run the user cancelled a second ago. A displaced driver can no longer commit
// an outcome and can still bring new compute into existence; the cancellation that raced it will never
// converge, because the thing it was converging on was created after it looked.
//
// And two dispatches onto one attempt both succeed. `runtime_work` is COALESCE-free last-write-wins, so the
// ledger ends up naming the second job while the first is still running — the exact "unaddressable live work"
// the column exists to prevent, arrived at from the other direction.
//
// THESE ARE INTERLEAVED ON PURPOSE (rule `testing`, and `protocol`'s verification reference). A sequential
// test — open, reserve, submit — passes today and always will: the defect lives in the window between the
// authority being checked and the effect being made, so the counterexample has to put another actor in it.

const INPUT = (over: Partial<OpenAttemptInput> = {}): OpenAttemptInput =>
  ({
    executionId: "evd-sc1-c1",
    tenant: "acme",
    scorecardId: "sc-1",
    caseId: "c1",
    driverEpoch: 1,
    ...over,
  }) as OpenAttemptInput;

const WORK = (over: Partial<RuntimeWorkRef> = {}): RuntimeWorkRef => ({
  tenant: "acme",
  runId: "evd-sc1-c1",
  externalJobId: "everdict-c1-aaaa",
  ...over,
});

// The parent ledger the reservation consults — a batch that is open and owned at a known epoch. Injected
// rather than joined, because the in-memory twin has no other table to reach; the Pg twin does the same
// question as a correlated EXISTS in the one UPDATE.
function parents(state: { epoch: number; terminal: boolean }) {
  return {
    async authorityOf() {
      return state.terminal ? undefined : { epoch: state.epoch };
    },
  };
}

// RED as of d841615b, observed on every arm:
//   promise resolved "{ attemptId: 'evd-sc1-c1#g1', …(2) }" instead of rejecting
describe("[R55 WAVE-1 COUNTEREXAMPLE #1 — CLOSED] a takeover between the check and the effect revokes the dispatch", () => {
  it("refuses to reserve work for a driver a newer epoch has displaced", async () => {
    const parent = { epoch: 1, terminal: false };
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents(parent));
    const opened = await attempts.open(INPUT());

    // …the driver computes its external id and is ABOUT to reserve. Another replica takes the batch here.
    parent.epoch = 2;

    await expect(
      attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId })),
      "a displaced driver reserved work — it can no longer commit an outcome, and it just created compute",
    ).rejects.toThrow();
  });

  it("refuses to reserve work for a parent that was cancelled while the dispatch was in flight", async () => {
    const parent = { epoch: 1, terminal: false };
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents(parent));
    const opened = await attempts.open(INPUT());

    // …the user cancels. The teardown enumerates what is live, finds nothing yet, and converges.
    parent.terminal = true;

    await expect(
      attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId })),
      "work was placed for a cancelled batch — the teardown that already converged will never see it",
    ).rejects.toThrow();
  });

  it("still reserves for the driver that holds the epoch — the guard is not a blanket refusal", async () => {
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents({ epoch: 1, terminal: false }));
    const opened = await attempts.open(INPUT());
    const intent = await attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId }));
    expect(intent.attemptId).toBe(opened.attemptId);
  });
});

describe("[R55 WAVE-1 COUNTEREXAMPLE #2 — CLOSED] one attempt authorizes one piece of work", () => {
  it("refuses a SECOND reservation naming different work", async () => {
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents({ epoch: 1, terminal: false }));
    const opened = await attempts.open(INPUT());
    await attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId }));

    // A second dispatch reaches the same attempt — a retry that did not know the first had gone through, a
    // duplicate the scheduler let past. Last-write-wins would leave the ledger naming job B while job A runs.
    await expect(
      attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId, externalJobId: "everdict-c1-bbbb" })),
      "a second reservation overwrote the handle of work that is still running",
    ).rejects.toThrow();
  });

  it("is IDEMPOTENT for the same work, so a retried reservation is not an error", async () => {
    // The other half: a caller that re-reserves the SAME external id is repeating itself, not racing. It gets
    // the proof back rather than a failure, because refusing here would fail a dispatch that is correct.
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents({ epoch: 1, terminal: false }));
    const opened = await attempts.open(INPUT());
    const first = await attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId }));
    const again = await attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId }));
    expect(again.work.externalJobId).toBe(first.work.externalJobId);
  });

  it("refuses once the attempt is no longer `created` — a superseded attempt places nothing", async () => {
    const attempts = new InMemoryExecutionAttemptStore(undefined, parents({ epoch: 1, terminal: false }));
    const opened = await attempts.open(INPUT());
    await attempts.transition(opened.attemptId, "superseded");
    await expect(
      attempts.reserveWork(opened.attemptId, WORK({ attemptId: opened.attemptId })),
      "a superseded attempt reserved work — its outcome is already somebody else's",
    ).rejects.toThrow();
  });
});
