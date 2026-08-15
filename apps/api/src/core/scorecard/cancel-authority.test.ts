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
