import { CancellationCoordinator, InMemoryCancellationStore, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { type EvalCase, UpstreamError } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// ── A DECIDED ABORT IS OWED TO SOMEBODY (arch-review 52, Wave 3) ────────────────────────────────────
//
// The batch lane already knows this: `CancellationStore` makes a cancelled scorecard's teardown a durable
// operation, and a reconciler owns it when the caller is gone (ports/cancellation-store.ts). The STANDALONE
// run lane has the same terminal-first protocol — commit failed{CANCELLED}, then tear the compute down — and
// none of the ledger. RunService.cancel's own comment names the caller's retry as the owner ("the retry costs
// nothing and re-runs the whole teardown"), which is true of a 5xx and false of a crash: a control plane that
// dies between the commit and a successful kill leaves a run that is terminal in the ledger and still burning
// on the cluster, with nothing in the system looking for the difference.
//
// The invariant: the same write that DECIDES the abort records that the teardown is owed, so a sweep can find
// and converge it. This is the run-scale twin of apps/api/src/core/scorecard/cancellation-protocol.test.ts.

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in cancel tests");
  },
};

const now = "2026-08-16T00:00:00.000Z";

const runningRun = () => ({
  ...Run.newQueued({
    id: "r1",
    tenant: "acme",
    harness: { id: "scripted", version: "0" },
    evalCase: CASE,
    runtime: "nomad-1",
    submittedBy: "alice",
    now,
  }),
  status: "running" as const,
});

// [WAVE-3 COUNTEREXAMPLE #6] RED as of 02a3e15e: `AssertionError: expected [] to have a length of 1 but got +0` —
// RunService.cancel commits the CANCELLED decision and then runs the teardown with no operation row behind it, so a
// process that dies before the kill confirms leaves nothing for a reconciler to sweep. UN-SKIPPED (wave 3).
const RUN_TARGET = { kind: "run", id: "r1" } as const;

describe("a standalone run's cancellation owes its teardown to a ledger, not to the caller staying alive", () => {
  it("the operation row exists the moment the CANCELLED settle commits — even when every API-level write fails", async () => {
    // THE CRASH WINDOW IS BETWEEN THE TWO WRITES, so a row written AFTER the decision does not close it. The
    // settle-time pair is the STORE's write (Postgres runs it inside the settle statement, mig 0186); the
    // wrapper's own request is the post-hoc lane. Model exactly that split — the attach writes through the
    // store's internals while every public write fails — and a row appearing anyway proves it rode the settle.
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const cancellations = new InMemoryCancellationStore();
    const settleTimeRequest = cancellations.request.bind(cancellations);
    store.attachCancellations((id) => void settleTimeRequest({ kind: "run", id }, now));
    // request, fail AND complete all upsert, so leaving any of them alive lets the post-hoc lane fabricate
    // the row this test exists to prove rode the settle.
    const down = async (): Promise<never> => {
      throw new Error("cancellation store API down");
    };
    cancellations.request = down;
    cancellations.fail = down;
    cancellations.complete = down;
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      now: () => now,
      killCase: async () => ({ status: "stopped" as const }),
      cancellations,
    });

    await service.cancel({ tenant: "acme", id: "r1" });

    expect((await store.get("r1"))?.error?.code).toBe("CANCELLED");
    // Owed by the settle itself — the crash window is gone.
    expect(await cancellations.get(RUN_TARGET)).toMatchObject({ state: "requested" });
  });

  it("records the owed teardown when the process cannot finish it, and a later sweep converges it", async () => {
    // Given a running run and a cluster that cannot be reached — the crash's observable shape: the decision
    // commits, the kill does not confirm, and this process is about to be gone.
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const cancellations = new InMemoryCancellationStore();
    // The settle→operation pair, in its production shape: Postgres inserts the row inside the CANCELLED
    // settle's own statement, and in memory the two stores are separate objects, so the pairing is the
    // attach. THIS is what closes the crash window — the wrapper's own re-request runs after the decision,
    // which is precisely the window a dying process falls into.
    store.attachCancellations((id) => void cancellations.request({ kind: "run", id }, now).catch(() => {}));
    const killed: string[] = [];
    let clusterReachable = false;
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      now: () => now,
      killCase: async (_tenant: string, _runtime: string | undefined, caseId: string) => {
        if (!clusterReachable) return { status: "failed" as const, reason: "nomad unreachable" };
        killed.push(caseId);
        return { status: "stopped" as const };
      },
      // Wave 3 wires the standalone lane to the ledger the batch lane already owns.
      cancellations,
    });

    // When the member stops the run and the teardown cannot complete
    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toBeInstanceOf(UpstreamError);

    // Then the decision is durable…
    expect((await store.get("r1"))?.error?.code).toBe("CANCELLED");
    // …and so is the fact that its teardown is still OWED. Without this row the run is indistinguishable from
    // one whose compute was freed: terminal in the ledger, live on the cluster, and nobody looking.
    expect(await cancellations.listIncomplete(10)).toHaveLength(1);
    expect(await cancellations.get(RUN_TARGET)).toMatchObject({ state: "requested" });

    // When a later sweep picks the operation up — the COORDINATOR, which is what a surviving replica runs:
    // no caller, no request object, only the row and the teardown that knows this kind of target. The steps
    // are idempotent end to end, which is what makes a sweep safe.
    clusterReachable = true;
    const coordinator = new CancellationCoordinator({
      cancellations,
      now: () => now,
      teardowns: { run: service.cancellationTeardown() },
    });
    expect(await coordinator.reconcile(10)).toBe(1);

    // Then the compute was actually freed, and the operation is closed — the reconciler never picks it up
    // again — with the certificate saying what the completion read back.
    expect(killed).toEqual(["c1"]);
    expect(await cancellations.get(RUN_TARGET)).toMatchObject({
      state: "completed",
      certificate: { kills: { stopped: 1, absent: 0 } },
    });
    expect(await cancellations.listIncomplete(10)).toEqual([]);
  });

  it("a run that is no longer cancelled closes its stale row without stopping anything", async () => {
    // The other half of the same rule: a sweep must never become a way to stop LIVE work. A row naming a run
    // the decision plane never aborted is unactionable, and closing it is the honest end.
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const cancellations = new InMemoryCancellationStore();
    const killed: string[] = [];
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      now: () => now,
      killCase: async (_tenant: string, _runtime: string | undefined, caseId: string) => {
        killed.push(caseId);
        return { status: "stopped" as const };
      },
      cancellations,
    });
    await cancellations.request(RUN_TARGET, now);

    const coordinator = new CancellationCoordinator({
      cancellations,
      now: () => now,
      teardowns: { run: service.cancellationTeardown() },
    });
    expect(await coordinator.reconcile(10)).toBe(1);

    expect(killed).toEqual([]); // nothing was stopped
    expect((await store.get("r1"))?.status).toBe("running"); // …and the run is untouched
    expect(await cancellations.listIncomplete(10)).toEqual([]);
  });

  it("a kind this replica cannot converge is left owed, never closed", async () => {
    // A coordinator wired with only the run teardown must not close a scorecard's row: closing an operation
    // you cannot converge is the same lie the ledger exists to prevent, one level up.
    const cancellations = new InMemoryCancellationStore();
    await cancellations.request({ kind: "scorecard", id: "sc-1" }, now);
    const coordinator = new CancellationCoordinator({
      cancellations,
      now: () => now,
      teardowns: {
        run: async () => ({ kind: "converged", certificate: { at: now } }),
      },
    });

    expect(await coordinator.reconcile(10)).toBe(0);
    expect(await cancellations.listIncomplete(10)).toHaveLength(1);
  });
});
