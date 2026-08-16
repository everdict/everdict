import {
  CancellationCoordinator,
  type CancellationStore,
  InMemoryCancellationStore,
  InMemoryCaseReceiptStore,
  ScorecardService,
} from "@everdict/application-control";
import type { CaseResult, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// The sweep moved off the service and onto the CancellationCoordinator (arch-review 52, Wave 3): one
// reconciler over one ledger, dispatching each owed row to the teardown that owns its KIND. These
// assertions are unchanged — only who is asked to run the pass.
const sweep = (service: ScorecardService, cancellations: CancellationStore): CancellationCoordinator =>
  new CancellationCoordinator({
    cancellations,
    now: () => new Date().toISOString(),
    teardowns: { scorecard: service.cancellationTeardown() },
  });

// ── A CANCEL THAT CANNOT SEE THE CHILDREN REFUSES, IT DOES NOT PRETEND (arch-review 46) ──────────────
//
// stopInFlight read the child list with `.catch(() => [])`: a transient store failure made the cancel kill
// and settle NOTHING while the route still reported success — every child left running, the user told the
// stop had happened. The read throws now; the record is already terminal, so a retried cancel simply
// re-runs the teardown.

function makeService(extraDeps: Record<string, unknown> = {}) {
  const store = new InMemoryScorecardStore();
  const receipts = new InMemoryCaseReceiptStore();
  store.attachReceipts((id) => receipts.countFor(id));
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  const service = new ScorecardService({
    dispatcher: {
      async dispatch(): Promise<CaseResult> {
        throw new Error("not under test");
      },
    },
    store,
    runStore: runs,
    caseReceipts: receipts,
    datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
    ...extraDeps,
  } as never);
  return { store, runs, receipts, service };
}

const runningRecord = (id: string): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "running",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }) as ScorecardRecord;

describe("ScorecardService.cancel — the teardown's child read is authoritative", () => {
  it("a child-list read failure fails the cancel visibly instead of resolving over a teardown that never ran", async () => {
    const store = new InMemoryScorecardStore();
    const receipts = new InMemoryCaseReceiptStore();
    store.attachReceipts((id) => receipts.countFor(id));
    const runs = new InMemoryRunStore();
    runs.attachScorecards(store);
    runs.list = async () => {
      throw new Error("child list unavailable");
    };
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("not under test");
        },
      },
      store,
      runStore: runs,
      caseReceipts: receipts,
      datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
    } as never);
    await store.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      status: "running",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);

    await expect(service.cancel({ tenant: "acme", id: "sc-1" })).rejects.toThrow(/child list unavailable/);
  });
});

describe("ScorecardService.cancel — a retry CONVERGES the teardown (arch-review 47 P0-1)", () => {
  it("a second cancel on an already-cancelled record re-runs the teardown instead of conflicting", async () => {
    // First cancel: terminal commit lands, then the child-list read fails → 5xx, children left running.
    // Pre-fix the retry hit the domain's terminal guard and re-ran NOTHING — compute and children stranded
    // behind a decision with no durable owner.
    const { store, runs, service } = makeService();
    await store.create(runningRecord("sc-1"));
    await runs.create({
      id: "child-1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "running",
      parentScorecardId: "sc-1",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as never);
    const realList = runs.list.bind(runs);
    let fail = true;
    runs.list = async (...args: Parameters<typeof realList>) => {
      if (fail) throw new Error("child list unavailable");
      return realList(...args);
    };
    await expect(service.cancel({ tenant: "acme", id: "sc-1" })).rejects.toThrow(/child list unavailable/);
    expect((await store.get("sc-1"))?.status).toBe("cancelled"); // the decision landed…
    expect((await runs.get("child-1"))?.status).toBe("running"); // …but the teardown did not

    fail = false; // the store recovers
    const again = await service.cancel({ tenant: "acme", id: "sc-1" }); // the retry: no conflict
    expect(again.status).toBe("cancelled");
    expect((await runs.get("child-1"))?.status).toBe("failed"); // the teardown converged
    expect((await runs.get("child-1"))?.error?.code).toBe("CANCELLED");
  });

  it("a rejected lease revocation fails the cancel — never a success over an unrevoked lease", async () => {
    const { store, service } = makeService({
      cancelLeased: () => Promise.reject(new Error("runner job store unavailable")),
    });
    await store.create(runningRecord("sc-2"));
    await expect(service.cancel({ tenant: "acme", id: "sc-2" })).rejects.toThrow(/runner job store unavailable/);
  });
});

// ── THE TEARDOWN IS A DURABLE OPERATION A RECONCILER OWNS (arch-review 47 §5.2) ──────────────────────
//
// Convergence needed somebody to converge: the retry above is honest only while a caller is alive to make it.
// A control-plane crash between the CANCELLED commit and a successful teardown left children running, leases
// held and cluster compute burning, with a human re-cancelling as the recovery procedure.
describe("ScorecardService cancellation operations — a crashed teardown still has an owner", () => {
  // The child-list read is the teardown's first durable step, so failing it is the whole teardown failing.
  const withFailingChildList = () => {
    const operations = new InMemoryCancellationStore();
    const { store, runs, service } = makeService({ cancellations: operations });
    const realList = runs.list.bind(runs);
    const state = { fail: true };
    runs.list = async (...args: Parameters<typeof realList>) => {
      if (state.fail) throw new Error("child list unavailable");
      return realList(...args);
    };
    return { operations, store, runs, service, state };
  };

  const childOf = (id: string, scorecardId: string) =>
    ({
      id,
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "running",
      parentScorecardId: scorecardId,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    }) as never;

  it("a failed teardown leaves an incomplete operation carrying the reason", async () => {
    const { operations, store, runs, service, state } = withFailingChildList();
    await store.create(runningRecord("sc-1"));
    await runs.create(childOf("child-1", "sc-1"));

    await expect(service.cancel({ tenant: "acme", id: "sc-1" })).rejects.toThrow(/child list unavailable/);

    expect((await store.get("sc-1"))?.status).toBe("cancelled"); // the decision landed…
    expect((await runs.get("child-1"))?.status).toBe("running"); // …and the teardown did not
    const owed = await operations.listIncomplete(10);
    expect(owed.map((op) => op.target)).toEqual([{ kind: "scorecard", id: "sc-1" }]);
    expect(owed[0]?.lastError).toMatch(/child list unavailable/);
    expect(state.fail).toBe(true);
  });

  it("the reconciler converges an orphaned teardown and completes its operation", async () => {
    // The crash is expressed by simply never retrying the cancel: nothing but the row remains.
    const { operations, store, runs, service, state } = withFailingChildList();
    await store.create(runningRecord("sc-1"));
    await runs.create(childOf("child-1", "sc-1"));
    await expect(service.cancel({ tenant: "acme", id: "sc-1" })).rejects.toThrow(/child list unavailable/);

    state.fail = false; // the store recovers; no caller is left to notice
    expect(await sweep(service, operations).reconcile()).toBe(1);

    expect((await runs.get("child-1"))?.status).toBe("failed");
    expect((await runs.get("child-1"))?.error?.code).toBe("CANCELLED");
    expect(await operations.listIncomplete(10)).toEqual([]);
  });

  it("a reconciler pass that still cannot tear down keeps the operation owed", async () => {
    const { operations, store, runs, service } = withFailingChildList();
    await store.create(runningRecord("sc-1"));
    await runs.create(childOf("child-1", "sc-1"));
    await expect(service.cancel({ tenant: "acme", id: "sc-1" })).rejects.toThrow(/child list unavailable/);

    expect(await sweep(service, operations).reconcile()).toBe(0); // the store is still down — nothing closed
    const owed = await operations.listIncomplete(10);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.lastError).toMatch(/child list unavailable/);
  });

  it("a completed operation is never re-run", async () => {
    const operations = new InMemoryCancellationStore();
    const { store, runs, service } = makeService({ cancellations: operations });
    await store.create(runningRecord("sc-1"));
    await runs.create(childOf("child-1", "sc-1"));
    await service.cancel({ tenant: "acme", id: "sc-1" }); // teardown succeeds first time

    expect(await operations.listIncomplete(10)).toEqual([]);
    let listed = 0;
    const realList = runs.list.bind(runs);
    runs.list = async (...args: Parameters<typeof realList>) => {
      listed += 1;
      return realList(...args);
    };
    expect(await sweep(service, operations).reconcile()).toBe(0);
    expect(listed).toBe(0); // the sweep did not touch the batch at all
  });

  it("an operation whose batch is not aborted is closed without tearing anything down", async () => {
    // A stale row must never become a way to stop live work: the reconciler runs the teardown only for a
    // batch the decision plane already marked aborted.
    const operations = new InMemoryCancellationStore();
    const { store, runs, service } = makeService({ cancellations: operations });
    await store.create(runningRecord("sc-live"));
    await runs.create(childOf("child-live", "sc-live"));
    await operations.request({ kind: "scorecard", id: "sc-live" }, "2026-08-15T00:00:00.000Z");

    expect(await sweep(service, operations).reconcile()).toBe(1);
    expect((await runs.get("child-live"))?.status).toBe("running"); // untouched
    expect((await store.get("sc-live"))?.status).toBe("running");
    expect(await operations.listIncomplete(10)).toEqual([]);
  });
});
