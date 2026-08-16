import { InMemoryCancellationStore, RunService } from "@everdict/application-control";
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
// process that dies before the kill confirms leaves nothing for a reconciler to sweep. Un-skip when wave 3 lands.
describe.skip("a standalone run's cancellation owes its teardown to a ledger, not to the caller staying alive", () => {
  it("records the owed teardown when the process cannot finish it, and a later sweep converges it", async () => {
    // Given a running run and a cluster that cannot be reached — the crash's observable shape: the decision
    // commits, the kill does not confirm, and this process is about to be gone.
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const cancellations = new InMemoryCancellationStore();
    const killed: string[] = [];
    let clusterReachable = false;
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      now: () => now,
      killCase: async (_tenant: string, _runtime: string | undefined, caseId: string) => {
        if (!clusterReachable) throw new Error("nomad unreachable");
        killed.push(caseId);
      },
      // Wave 3 wires the standalone lane to the ledger the batch lane already owns.
      cancellations,
    } as never);

    // When the member stops the run and the teardown cannot complete
    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toBeInstanceOf(UpstreamError);

    // Then the decision is durable…
    expect((await store.get("r1"))?.error?.code).toBe("CANCELLED");
    // …and so is the fact that its teardown is still OWED. Without this row the run is indistinguishable from
    // one whose compute was freed: terminal in the ledger, live on the cluster, and nobody looking.
    expect(await cancellations.listIncomplete(10)).toHaveLength(1);
    expect(await cancellations.get("r1")).toMatchObject({ state: "requested" });

    // When a later sweep picks the operation up (the reconciler, on this replica or another) and the cluster
    // is reachable again — the teardown is idempotent end to end, which is what makes a sweep safe
    clusterReachable = true;
    for (const _owed of await cancellations.listIncomplete(10)) {
      await service.cancel({ tenant: "acme", id: "r1" });
    }

    // Then the compute was actually freed, and the operation is closed — the reconciler never picks it up again.
    expect(killed).toEqual(["c1"]);
    expect(await cancellations.get("r1")).toMatchObject({ state: "completed" });
    expect(await cancellations.listIncomplete(10)).toEqual([]);
  });
});
