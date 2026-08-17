import { describe, expect, it, vi } from "vitest";
import type { CancellationCertificate, CancellationStore, CancellationTarget } from "../ports/cancellation-store.js";
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

function ledger(): { store: CancellationStore; completed: CancellationCertificate[] } {
  const completed: CancellationCertificate[] = [];
  const store = {
    async request() {},
    async complete(_t: CancellationTarget, _at: string, certificate?: CancellationCertificate) {
      if (certificate) completed.push(certificate);
    },
    async fail() {},
    async listOwed() {
      return [];
    },
  } as unknown as CancellationStore;
  return { store, completed };
}

// RED as of 186f9fd9: the operation completes on the strength of the teardown returning — no probe is made,
// and no field of the certificate is a readback of live managed work.
describe.skip("[R53 WAVE-E COUNTEREXAMPLE #22] an operation completes only when a readback says zero", () => {
  it("does not complete on the strength of stop commands having returned", async () => {
    const { store, completed } = ledger();
    const probe = vi.fn(async () => ({ activeManagedWork: 1 }));

    await runDurableTeardown({ cancellations: store, now: () => "2026-08-17T00:00:00.000Z" }, TARGET, async () => ({
      at: "2026-08-17T00:00:00.000Z",
      // Every stop this teardown issued came back converged…
      kills: { stopped: 2, absent: 0 },
    }));

    // …and one of the jobs is still running, which nobody asked. The completion must be conditional on a
    // readback, and the readback must be the thing the certificate reports.
    expect(probe, "the teardown completed without probing the work it claims to have freed").toHaveBeenCalled();
    expect(completed[0]).toBeUndefined();
  });
});

// RED as of 186f9fd9: `expected undefined to be 0` — the certificate has no zero-live-state fields at all.
describe.skip("[R53 WAVE-E COUNTEREXAMPLE #23] the certificate states what it counted to zero", () => {
  it("reports active managed work, runner leases, queued intents and workflows — each a readback", async () => {
    const { store, completed } = ledger();
    await runDurableTeardown({ cancellations: store, now: () => "2026-08-17T00:00:00.000Z" }, TARGET, async () => ({
      at: "2026-08-17T00:00:00.000Z",
      kills: { stopped: 1, absent: 0 },
      leasesSignalled: 1,
    }));

    const cert = completed[0] as
      | (CancellationCertificate & {
          activeManagedWork?: number;
          activeRunnerLeases?: number;
          queuedDispatchIntents?: number;
          activeWorkflows?: number;
          unverifiable?: number;
        })
      | undefined;

    expect(cert?.activeManagedWork, "no readback of managed work").toBe(0);
    expect(cert?.activeRunnerLeases, "leasesSignalled counts signals, not survivors").toBe(0);
    expect(cert?.queuedDispatchIntents, "a reserved-but-unsubmitted intent is live work too").toBe(0);
    expect(cert?.activeWorkflows, "the workflow that dispatches more cases is not checked").toBe(0);
    expect(cert?.unverifiable, "nothing states how much could not be verified").toBe(0);
  });
});

// RED as of 186f9fd9: the operation has `requested | completed | failed` and no verifying step, so a
// teardown whose readback is unavailable has only two options — lie or throw.
describe.skip("[R53 WAVE-E COUNTEREXAMPLE #24] an unverifiable readback keeps the operation owed, bounded", () => {
  it("has a verifying state and a stated unverifiable end", async () => {
    const states = (await import("../ports/cancellation-store.js")) as unknown as Record<string, unknown>;
    const vocabulary = JSON.stringify(states.CANCELLATION_OPERATION_STATES ?? []);

    expect(vocabulary, "no verifying state — a readback that cannot be taken has nowhere to live").toContain(
      "verifying",
    );
    expect(
      vocabulary,
      "no unverifiable end — an unreachable orchestrator would leave an operation that can never close",
    ).toContain("unverifiable");
  });
});
