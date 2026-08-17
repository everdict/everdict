import { describe, expect, it } from "vitest";
import type { CancellationCertificate, CancellationStore, CancellationTarget } from "../ports/cancellation-store.js";
import { CANCELLATION_OPERATION_STATES } from "../ports/cancellation-store.js";
import { runDurableTeardown } from "./cancellation-coordinator.js";

// ── COMPLETION IS A VERIFIED STATE, NOT A COMMAND RECEIPT (arch-review 53, Wave E) ───────────────────
//
// Wave 3 gave the teardown a durable owner and an honest per-call answer. What it did not give it is a
// POSTCONDITION. `runDurableTeardown` completes the operation the moment the teardown function returns a
// certificate, and that certificate is an account of the CALLS this teardown made:
//
//   · `kills: {stopped, absent}` — how many stop requests came back converged. `stopped` means the
//     orchestrator ACCEPTED a delete, not that the object is gone; a Job in `Terminating` answers `stopped`
//     while its container keeps running to its grace period, and a Nomad deregister is asynchronous by design.
//   · `leasesSignalled` — the certificate's own comment says it is "NOT a liveness reading": it counts rows
//     this call flagged, so a converged re-run reports 0 for "already flagged" exactly as it would for
//     "nothing existed".
//   · nothing at all about the scheduler's queued intents or the workflow's own state.
//
// So "cancellation completed" currently means "the stop commands returned", and the compute it was supposed
// to free may still be burning — which is the exact claim this whole protocol was built to be able to make
// honestly. The operator-visible consequence is a batch that reads CANCELLED with allocations still running,
// and a bill for them.
//
// The invariant these pin: an operation completes only after a READBACK shows zero live work, and a readback
// that could not be taken keeps the operation owed — with a bounded, explicitly-stated `unverifiable` end so
// a permanently unreachable orchestrator does not create an operation that can never close.

const TARGET: CancellationTarget = { kind: "run", id: "r1" };

const NOW = "2026-08-17T00:00:00.000Z";

function ledger(): {
  store: CancellationStore;
  completed: CancellationCertificate[];
  failed: Array<{ state: string; error: string }>;
  abandoned: string[];
} {
  const completed: CancellationCertificate[] = [];
  const failed: Array<{ state: string; error: string }> = [];
  const abandoned: string[] = [];
  let attempts = 0;
  const store = {
    async request() {},
    async complete(_t: CancellationTarget, _at: string, certificate?: CancellationCertificate) {
      if (certificate) completed.push(certificate);
    },
    async fail(_t: CancellationTarget, error: string, _now: string, state = "requested") {
      if (state === "verifying") attempts += 1;
      failed.push({ state, error });
    },
    async abandon(_t: CancellationTarget, reason: string) {
      abandoned.push(reason);
    },
    async get() {
      return { target: TARGET, state: "verifying" as const, requestedAt: NOW, verificationAttempts: attempts };
    },
    async listIncomplete() {
      return [];
    },
  } as unknown as CancellationStore;
  return { store, completed, failed, abandoned };
}

// RED as of 186f9fd9: the operation completed on the strength of the teardown returning — no probe was made,
// and no field of the certificate was a readback of live managed work.
describe("[R53 WAVE-E COUNTEREXAMPLE #22 — CLOSED] an operation completes only when a readback says zero", () => {
  it("does not complete on the strength of stop commands having returned", async () => {
    const { store, completed, failed } = ledger();

    // The teardown itself refuses when its readback found live work — that refusal is what keeps the
    // operation owed, and it is the shape `RunService.stopRun` throws.
    await runDurableTeardown({ cancellations: store, now: () => NOW }, TARGET, async () => {
      throw Object.assign(new Error("compute not confirmed freed"), {
        data: { activeManagedWork: 1, unverifiable: 0 },
      });
    }).catch(() => undefined);

    expect(completed, "the teardown completed without the world coming back quiet").toEqual([]);
    // …and it is recorded as VERIFYING, not merely requested: the stops ran, and it was the readback that
    // did not come back zero. An operator reads the difference.
    expect(failed[0]?.state).toBe("verifying");
  });
});

// RED as of 186f9fd9: `expected undefined to be 0` — the certificate had no zero-live-state fields at all.
describe("[R53 WAVE-E COUNTEREXAMPLE #23 — CLOSED] the certificate states what it counted to zero", () => {
  it("carries the readback counts, and an absent reading is stated by absence rather than as a zero", async () => {
    const { store, completed } = ledger();
    await runDurableTeardown({ cancellations: store, now: () => NOW }, TARGET, async () => ({
      at: NOW,
      kills: { stopped: 1, absent: 0 },
      leasesSignalled: 1,
      // The readback this teardown actually took.
      activeManagedWork: 0,
      unverifiable: 0,
    }));

    const cert = completed[0];
    expect(cert?.activeManagedWork, "no readback of managed work").toBe(0);
    expect(cert?.unverifiable, "nothing states how much could not be verified").toBe(0);
    // A reading nobody took is ABSENT, never 0 — the certificate says what it saw.
    expect(cert?.activeWorkflows).toBeUndefined();
  });
});

// RED as of 186f9fd9: the operation had `requested | completed` and no verifying step, so a teardown whose
// readback was unavailable had only two options — lie or throw forever.
describe("[R53 WAVE-E COUNTEREXAMPLE #24 — CLOSED] an unverifiable readback keeps the operation owed, bounded", () => {
  it("has a verifying state and a stated unverifiable end", () => {
    expect(
      CANCELLATION_OPERATION_STATES,
      "no verifying state — a readback that cannot be taken has nowhere to live",
    ).toContain("verifying");
    expect(
      CANCELLATION_OPERATION_STATES,
      "no unverifiable end — an unreachable orchestrator would leave an operation that can never close",
    ).toContain("unverifiable");
  });

  it("closes the operation unverifiable once the readback budget is spent", async () => {
    const { store, abandoned } = ledger();
    const failing = async (): Promise<CancellationCertificate> => {
      throw Object.assign(new Error("cluster unreachable"), { data: { activeManagedWork: 0, unverifiable: 1 } });
    };

    // Two attempts under a budget of two: the first leaves it owed, the second spends the budget.
    await runDurableTeardown({ cancellations: store, now: () => NOW, verificationBudget: 2 }, TARGET, failing).catch(
      () => undefined,
    );
    expect(abandoned).toEqual([]);
    await runDurableTeardown({ cancellations: store, now: () => NOW, verificationBudget: 2 }, TARGET, failing).catch(
      () => undefined,
    );

    // …and it closes WITH its reason, because an operation nobody can converge must not sit owed forever
    // pretending it might.
    expect(abandoned[0], "an unreachable orchestrator leaves an operation that can never close").toContain(
      "could not be established",
    );
  });
});
