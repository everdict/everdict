import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── WHICH CHILD RUN IS A CASE'S ANSWER, AS A SERVED MAP (arch-review 44) ─────────────────────────────
//
// The batch already decides this at commit time and hydrates its own results from it. What it never did was
// SAY so: clients paired the Nth result with the Nth child by createdAt and fell back to "the last child" when
// the counts disagreed — which is exactly the shape a retry produces, so a retried case's "open the replay"
// link pointed at the SUPERSEDED attempt while the row beside it showed the committed attempt's verdict.
//
// These pin the map the read model now serves: the receipt names the winner (never the clock), the trial axis
// survives, and a case the ledger cannot answer for is ABSENT rather than guessed at.

const result = (caseId: string, value: number, trial?: number): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: `v${value}` },
  scores: [{ metric: "pass", graderId: "g", value, pass: value > 0 }],
  ...(trial !== undefined ? { trial } : {}),
});

// createdAt/updatedAt are the axes the deleted heuristics ranked on — the superseded attempts here are
// deliberately the NEWEST rows, so a clock-based answer cannot accidentally agree with the receipt's.
const child = (id: string, caseId: string, at: string, r?: CaseResult): RunRecord =>
  ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1.0.0" },
    caseId,
    status: r ? "succeeded" : "failed",
    parentScorecardId: "sc-1",
    ...(r ? { result: r } : {}),
    createdAt: at,
    updatedAt: at,
  }) as RunRecord;

function fixtures() {
  const receipts = new InMemoryCaseReceiptStore();
  const store = new InMemoryScorecardStore();
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
  } as never);
  return { receipts, store, runs, service };
}

const batch = (runIds: string[]): ScorecardRecord =>
  ({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1.0.0" },
    status: "succeeded",
    runIds,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  }) as ScorecardRecord;

async function receipt(
  receipts: InMemoryCaseReceiptStore,
  caseId: string,
  trial: number,
  childRunId: string,
): Promise<void> {
  await receipts.commit({
    scorecardId: "sc-1",
    caseId,
    trial,
    childRunId,
    resultDigest: `${caseId}#${trial}`,
    committedAt: "2026-08-15T00:00:10.000Z",
  });
}

describe("ScorecardService.canonicalCaseRuns — the receipt names the case's run", () => {
  it("names the receipted child of a retried case, never the newest attempt", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-committed", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1)));
    // The abandoned attempt is younger AND last in the list — every clock/position heuristic prefers it.
    await runs.create(child("run-superseded", "c1", "2026-08-15T00:00:09.000Z"));
    await receipt(receipts, "c1", 0, "run-committed");
    await store.create(batch(["run-committed", "run-superseded"]));

    expect(await service.canonicalCaseRuns("sc-1")).toEqual([{ caseId: "c1", trial: 0, runId: "run-committed" }]);
  });

  it("keeps the TRIAL axis — a trialled case has one answer per trial, not one per case", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-t0", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1, 0)));
    await runs.create(child("run-t1", "c1", "2026-08-15T00:00:02.000Z", result("c1", 0, 1)));
    await runs.create(child("run-t1-retry", "c1", "2026-08-15T00:00:03.000Z", result("c1", 1, 1)));
    await receipt(receipts, "c1", 0, "run-t0");
    await receipt(receipts, "c1", 1, "run-t1-retry");
    await store.create(batch(["run-t0", "run-t1", "run-t1-retry"]));

    expect(await service.canonicalCaseRuns("sc-1")).toEqual([
      { caseId: "c1", trial: 0, runId: "run-t0" },
      { caseId: "c1", trial: 1, runId: "run-t1-retry" },
    ]);
  });

  it("is sorted by (case, trial) whatever order the ledger hands back — a served map is an identity, not an iteration accident", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-zz", "zz", "2026-08-15T00:00:01.000Z", result("zz", 1)));
    await runs.create(child("run-aa", "aa", "2026-08-15T00:00:02.000Z", result("aa", 1)));
    await receipt(receipts, "zz", 0, "run-zz");
    await receipt(receipts, "aa", 0, "run-aa");
    await store.create(batch(["run-zz", "run-aa"]));

    expect((await service.canonicalCaseRuns("sc-1")).map((c) => c.caseId)).toEqual(["aa", "zz"]);
  });

  it("says nothing about a case the ledger never committed — absence, so the client can tell 'unknown' from an answer", async () => {
    const { store, runs, service } = fixtures();
    await runs.create(child("run-legacy", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1)));
    await store.create(batch(["run-legacy"]));

    expect(await service.canonicalCaseRuns("sc-1")).toEqual([]);
  });

  it("drops a receipt naming a child this batch cannot see — never substitutes some other row for it", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-visible", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1)));
    await receipt(receipts, "c1", 0, "run-gone");
    await store.create(batch(["run-visible"]));

    expect(await service.canonicalCaseRuns("sc-1")).toEqual([]);
  });

  it("answers over the caller's own child list when it has one — the runs-list route lists them anyway", async () => {
    const { receipts, store, runs, service } = fixtures();
    const committed = child("run-committed", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1));
    await runs.create(committed);
    await receipt(receipts, "c1", 0, "run-committed");
    await store.create(batch(["run-committed"]));

    expect(await service.canonicalCaseRuns("sc-1", [committed])).toEqual([
      { caseId: "c1", trial: 0, runId: "run-committed" },
    ]);
    // …and a child the caller cannot see is not answered for on its behalf.
    expect(await service.canonicalCaseRuns("sc-1", [])).toEqual([]);
  });

  it("an unreadable ledger fails the read — it never degrades into the positional guess this map deletes", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-1", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1)));
    await store.create(batch(["run-1"]));
    receipts.list = async () => {
      throw new Error("ledger down");
    };
    await expect(service.canonicalCaseRuns("sc-1")).rejects.toThrow(/ledger down/);
  });
});
