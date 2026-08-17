import { InMemoryExecutionAttemptStore, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { EvalCase, RuntimeWorkRef } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { Run } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";

// ── A CANCEL STOPS THE WORK IT WAS ISSUED FOR (arch-review 52, Wave 2) ───────────────────────────────
//
// `killUnhandled(caseId)` selects on the case alone, so cancelling one run stopped every concurrent execution of
// that case — another run's, another tenant's. The dispatch now reports the exact object it created
// (`DispatchOptions.onWork`), the attempt ledger persists it, and the teardown addresses THAT. These pin the
// two halves that make the fallback safe to keep: the handle is preferred when one exists, and it is the
// ONLY thing called then — firing both would put the blast radius straight back.

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};
const now = "2026-08-16T00:00:00.000Z";
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("no dispatch in cancel tests");
  },
};

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

const WORK: RuntimeWorkRef = {
  tenant: "acme",
  runtimeId: "nomad-1",
  runId: "evd-run-r1",
  externalJobId: "everdict-c1-evd-run-r1-aaaaa",
  namespace: "everdict-acme",
};

describe("a cancelled run's teardown addresses the work its dispatch created", () => {
  it("kills by the recorded handle — and does NOT also fire the case-id kill", async () => {
    // Given a running run whose attempt recorded where its compute went
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const attempts = new InMemoryExecutionAttemptStore(() => now);
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme", caseId: "c1" });
    await attempts.recordWork(attemptId, WORK);
    const killWork = vi.fn(async () => ({ status: "stopped" as const }));
    const killUnhandled = vi.fn(async () => ({ status: "stopped" as const }));
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      attempts,
      killWork,
      killUnhandled,
      now: () => now,
    });

    // When the member stops it
    await service.cancel({ tenant: "acme", id: "r1" });

    // Then the stop names the one orchestrator object this run placed, in the namespace it was placed in…
    expect(killWork).toHaveBeenCalledTimes(1);
    expect(killWork).toHaveBeenCalledWith("acme", "nomad-1", WORK);
    // …and the case-id kill — which would have reached every OTHER run of case c1 — never fires. A teardown
    // that does both is a teardown with the old blast radius plus an extra call.
    expect(killUnhandled).not.toHaveBeenCalled();
  });

  it("answers by LANE when no attempt recorded a handle — never by widening to the case id", async () => {
    // Given a running run whose attempt ledger holds a row with no work handle on it
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const attempts = new InMemoryExecutionAttemptStore(() => now);
    await attempts.open({ executionId: "evd-run-r1", tenant: "acme", caseId: "c1" });
    const killWork = vi.fn(async () => ({ status: "stopped" as const }));
    const killUnhandled = vi.fn(async () => ({ status: "stopped" as const }));
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      attempts,
      killWork,
      killUnhandled,
      now: () => now,
    });

    await service.cancel({ tenant: "acme", id: "r1" });

    // Then no exact stop is possible, and the over-broad case-id kill that used to stand here is GONE
    // (arch-review 53, legacy removal): it stopped every run's job of that case, and on Nomad every
    // tenant's. What runs instead answers about the LANE — `absent` for a lease queue that placed no
    // orchestrator object, `unknown` for a managed lane whose work this system cannot name — and it takes no
    // case id at all, because there is no longer an action to point one at.
    expect(killWork).not.toHaveBeenCalled();
    expect(killUnhandled).toHaveBeenCalledWith("acme", "nomad-1");
  });

  it("a failed exact kill keeps the cancellation owed — the run is terminal, the compute is not", async () => {
    const store = new InMemoryRunStore();
    await store.create(runningRun());
    const attempts = new InMemoryExecutionAttemptStore(() => now);
    const { attemptId } = await attempts.open({ executionId: "evd-run-r1", tenant: "acme", caseId: "c1" });
    await attempts.recordWork(attemptId, WORK);
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      attempts,
      // The honest answer a cluster that cannot be reached gives (arch-review 52, Wave 3) — read as "not
      // converged", where the rejection this replaced was the only signal that ever surfaced.
      killWork: async () => ({ status: "failed" as const, reason: "nomad unreachable" }),
      now: () => now,
    });

    // The decision has committed and the work has not stopped — that is a 5xx the caller retries, never a
    // cancel that reports done over live compute.
    await expect(service.cancel({ tenant: "acme", id: "r1" })).rejects.toThrow(/has not converged/);
    expect((await store.get("r1"))?.error?.code).toBe("CANCELLED"); // …and the decision stays committed
  });
});
