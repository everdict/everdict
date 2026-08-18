import type { RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore, attemptParentAuthority } from "../ports/execution-attempt-store.js";

// ── A PROOF HAS A LIFETIME, AND IDEMPOTENCY IS NOT AN EXEMPTION (arch-review 56, Wave D) ─────────────
//
// L1 already says a proof is re-proved in the write that records the intent, and Wave A made the reservation
// a conditional transition that asserts it. Both stores then hand out a `PersistedWorkIntent` on a path that
// asserts nothing at all:
//
//     const held = <the attempt's runtime_work>;
//     if (held?.externalJobId === work.externalJobId) return { attemptId, work: held, persistedAt };
//
// This is the retry shortcut: a caller re-offering the SAME external id is repeating itself, and the guarded
// UPDATE below it would refuse for `runtime_work IS NULL`. It is correct about identity and silent about
// authority. Between the first reservation and the retry, the parent can be cancelled, superseded, or taken
// over at a new epoch — and the retry still returns a proof, and the backend still submits, because a proof
// is a capability and this one was minted from a memory.
//
//     reserve W          → intent
//     user cancels       → batch terminal, teardown kills W (absent: nothing was created yet)
//     submit retries     → same id → intent returned, no authority asked → cluster job created
//
// The cancellation converged on a world where the work did not exist, and the work appeared afterwards. That
// is L5's other half: after a cancellation the subject may no longer authorize external work, and "no longer"
// has to include the paths that authorize by remembering.
//
// Same identity is a reason to be IDEMPOTENT — to return the same handle rather than mint a second one. It is
// not a reason to skip the question the guarded write exists to ask.

const WORK: RuntimeWorkRef = { tenant: "acme", runId: "evd-sc-1-c1", externalJobId: "everdict-c1-aaaa" };

// A parent whose status the test moves under the caller's feet — the interleaving that makes the shortcut
// observable, and the only one in which it differs from the guarded write.
function world(initial = "running") {
  const parent = { status: initial, ownerEpoch: 0 };
  const attempts = new InMemoryExecutionAttemptStore(
    undefined,
    attemptParentAuthority({
      scorecards: {
        async get() {
          return parent;
        },
      },
      runs: {
        async get() {
          return undefined;
        },
      },
    }),
  );
  return { parent, attempts };
}

async function openOne(attempts: InMemoryExecutionAttemptStore): Promise<string> {
  // Opened WITH the driver epoch, as a batch lane opens it. Without one the epoch comparison is skipped by
  // design (the single-process CLI has no parent to be displaced from), and a fixture that omitted it would
  // assert the takeover case over a row that never recorded who was driving.
  const opened = await attempts.open({
    executionId: "evd-sc-1-c1",
    tenant: "acme",
    scorecardId: "sc-1",
    caseId: "c1",
    driverEpoch: 0,
  } as never);
  return opened.attemptId;
}

// RED as of f762f10c, observed:
//   a cancelled batch re-authorized the work its teardown had already converged on:
//   expected [Function] to throw an error
describe("[R56 WAVE-D COUNTEREXAMPLE #5 — CLOSED] a re-offered reservation re-proves its authority", () => {
  it("refuses the same work once the parent may no longer place any", async () => {
    const w = world();
    const attemptId = await openOne(w.attempts);
    const first = await w.attempts.reserveWork(attemptId, { ...WORK, attemptId });
    expect(first.work.externalJobId).toBe(WORK.externalJobId);

    // …the user cancels, and the teardown converges: the cluster has nothing under this handle yet.
    w.parent.status = "cancelled";

    await expect(
      w.attempts.reserveWork(attemptId, { ...WORK, attemptId }),
      "a cancelled batch re-authorized the work its teardown had already converged on",
    ).rejects.toThrow(/no longer|cancelled|authorize/i);
  });

  it("refuses when a takeover moved the epoch, even for work this attempt itself reserved", async () => {
    // The other revocation: the batch is still OPEN, and this driver is no longer the one driving it. The
    // handle is genuinely this attempt's — which is exactly why remembering it is not enough.
    const w = world();
    const attemptId = await openOne(w.attempts);
    await w.attempts.reserveWork(attemptId, { ...WORK, attemptId });

    w.parent.ownerEpoch = 7; // a later recovery claimed the batch

    await expect(w.attempts.reserveWork(attemptId, { ...WORK, attemptId })).rejects.toThrow(/no longer|authorize/i);
  });

  it("stays IDEMPOTENT while the authority holds — the same handle, never a second one", async () => {
    // The property the shortcut exists for, and the reason the fix is a re-check rather than a removal: a
    // dispatch that retries under an unchanged world must get its own handle back, not a conflict.
    const w = world();
    const attemptId = await openOne(w.attempts);
    const first = await w.attempts.reserveWork(attemptId, { ...WORK, attemptId });
    const again = await w.attempts.reserveWork(attemptId, { ...WORK, attemptId });

    expect(again.work.externalJobId).toBe(first.work.externalJobId);
    expect(again.persistedAt).toBe(first.persistedAt); // the ORIGINAL reservation, not a fresh stamp
  });

  it("still refuses DIFFERENT work on a taken attempt — the conflict is unchanged", async () => {
    const w = world();
    const attemptId = await openOne(w.attempts);
    await w.attempts.reserveWork(attemptId, { ...WORK, attemptId });
    await expect(w.attempts.reserveWork(attemptId, { ...WORK, attemptId, externalJobId: "other" })).rejects.toThrow(
      /already authorized other work/,
    );
  });
});
