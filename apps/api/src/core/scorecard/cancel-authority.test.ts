import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseResult, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

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
