import { describe, expect, it } from "vitest";
import {
  type CancellationStore,
  type CancellationTarget,
  InMemoryCancellationStore,
} from "../ports/cancellation-store.js";
import { CancellationCoordinator, runDurableTeardown } from "./cancellation-coordinator.js";

// ── ONE VERIFIER, OR TWO PROTOCOLS (arch-review 54, Phase 5) ─────────────────────────────────────────
//
// Wave E gave the caller-facing teardown a postcondition read: after the stops are issued, re-probe the exact
// work handles and refuse to complete while anything is live or unreadable. It also gave the operation a
// verification budget, a `verifying` state for "the stops ran and the world is not quiet yet", and an
// `unverifiable` close for a budget that ran out.
//
// All of that lives in `runDurableTeardown`. The RECONCILER — the sweep that exists precisely because the
// process holding the caller's retry died — calls the teardown directly and records a bare failure:
//
//     result = await teardown(operation.target.id);
//     } catch (err) {
//       await cancellations.fail(operation.target, message, now())   // ← no `state`, so: "requested"
//
// So the two paths disagree about what happened. A live process learns `verifying`, counts an attempt against
// the budget, and eventually escalates. A restarted one records `requested` forever, never increments the
// counter, and never escalates — the same cluster, the same unreachable job, two different stories, and the
// story a human reads depends on which process happened to be alive.
//
// The counter is on the ROW for exactly this reason ("read from the row rather than counted in memory, because
// the retries are spread across processes"), and the sweep is the process the spreading refers to.
//
// The invariant: one durable wrapper, used by the request path AND every reconciler. See rule `protocol` L5.

const TARGET: CancellationTarget = { kind: "run", id: "evd-run-1" };
const NOW = "2026-08-18T00:00:00.000Z";

// A teardown that issues its stops and finds the world still busy — the shape `RunService.stopRun` throws
// when its post-kill readback comes back non-zero.
const unquiet = () => {
  const err = new Error("compute is not confirmed freed") as Error & { data?: unknown };
  err.data = { activeManagedWork: 1, unverifiable: 0 };
  throw err;
};

// RED as of efe3657e, observed: `expected 'requested' to be 'verifying'`.
describe("[R54 PHASE-5 COUNTEREXAMPLE #16 — CLOSED] the reconciler converges through the same wrapper as the caller", () => {
  it("records `verifying` — not a bare failure — when the postcondition read came back non-zero", async () => {
    const cancellations = new InMemoryCancellationStore();
    await cancellations.request(TARGET, NOW);

    const coordinator = new CancellationCoordinator({
      cancellations,
      teardowns: { run: async () => unquiet() },
      now: () => NOW,
    });
    await coordinator.reconcile();

    const operation = await cancellations.get(TARGET);
    expect(
      operation?.state,
      "the sweep recorded a plain failure, so the same situation reads as `requested` after a restart and `verifying` before it",
    ).toBe("verifying");
  });

  it("counts the attempt against the budget the caller path counts against", async () => {
    const cancellations = new InMemoryCancellationStore();
    await cancellations.request(TARGET, NOW);

    // Two sweeps of the same unreachable target. The budget is on the row precisely so that attempts made by
    // different processes add up.
    const coordinator = new CancellationCoordinator({
      cancellations,
      teardowns: { run: async () => unquiet() },
      now: () => NOW,
      verificationBudget: 2,
    } as never);
    await coordinator.reconcile();
    await coordinator.reconcile();

    const operation = await cancellations.get(TARGET);
    expect(operation?.verificationAttempts, "the sweep's attempts did not count").toBe(2);
    // …and having spent the budget it ESCALATES — which is not the same as closing. The row stays owed
    // (`verifying`: the stops ran and the world did not come back quiet) and gains the alert. Planting this
    // counterexample, it asserted `state === "unverifiable"`, following Wave E's shape; the phase that closed
    // it concluded that a terminal state there removes a live-compute debt from the only loop that would ever
    // retry it, so the debt and the alert are separate fields now.
    expect(operation?.state).toBe("verifying");
    expect(operation?.escalation?.kind).toBe("unverifiable");
    expect(operation?.escalation?.attempts).toBe(2);
    // Backed off rather than re-swept every cycle.
    expect(operation?.nextAttemptAt).toBeTruthy();
  });
});

// RED as of efe3657e, observed: `expected [] to have a length of 1`.
describe("[R54 PHASE-5 COUNTEREXAMPLE #17 — CLOSED] an unverifiable cancellation is escalated debt, not a closed one", () => {
  it("stays in the sweep, with the escalation recorded beside it", async () => {
    const cancellations: CancellationStore = new InMemoryCancellationStore();
    await cancellations.request(TARGET, NOW);
    await runDurableTeardown({ cancellations, now: () => NOW, verificationBudget: 1 }, TARGET, async () =>
      unquiet(),
    ).catch(() => undefined);

    const owed = await cancellations.listIncomplete(50);
    expect(
      owed.map((o) => o.target.id),
      "a teardown we could not verify was removed from the only loop that would ever retry it",
    ).toHaveLength(1);
    const operation = await cancellations.get(TARGET);
    // The debt stays owed; what changes is that a human is told. Terminal means verified — nothing else does.
    expect((operation as { escalation?: { kind: string } } | undefined)?.escalation?.kind).toBe("unverifiable");
  });
});
