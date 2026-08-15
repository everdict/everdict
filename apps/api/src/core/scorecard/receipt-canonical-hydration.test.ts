import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── THE READ-BACK USES THE SAME CANONICALITY THE WRITE SIDE TRUSTS (arch-review 43, Phase 3) ─────────
//
// Every scorecard reader funnels through ScorecardService.get()'s hydration. Pre-fix it filtered children
// by runIds membership: a resumed batch's superseded child rode beside the committed one (duplicates on the
// wire, a superseded attempt's trace served as evidence). And the first cut of the fix switched per BATCH,
// which dropped pre-receipt cases entirely. This pins the per-case shape: receipted case → the receipt's
// child; unreceipted case → the membership row; order deterministic regardless of store iteration.

const result = (caseId: string, value: number, trial?: number): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: `v${value}` },
  scores: [{ metric: "pass", graderId: "g", value, pass: value > 0 }],
  ...(trial !== undefined ? { trial } : {}),
});

const child = (id: string, caseId: string, status: string, r?: CaseResult): RunRecord =>
  ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1.0.0" },
    caseId,
    status,
    parentScorecardId: "sc-1",
    ...(r ? { result: r } : {}),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
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

describe("ScorecardService.get — receipt-canonical hydration, per case", () => {
  it("serves the receipt's child for a receipted case, the membership row for an unreceipted one, deduplicated and in deterministic order", async () => {
    const { receipts, store, runs, service } = fixtures();
    // Case zz: two children (a superseded attempt + the committed winner) — the receipt names the winner.
    await runs.create(child("run-super", "zz", "failed", result("zz", 0)));
    await runs.create(child("run-winner", "zz", "succeeded", result("zz", 1)));
    // Case aa: a pre-receipt child (no receipt row at all) — membership must still serve it.
    await runs.create(child("run-legacy", "aa", "succeeded", result("aa", 1)));
    await receipts.commit({
      scorecardId: "sc-1",
      caseId: "zz",
      trial: 0,
      childRunId: "run-winner",
      resultDigest: "d",
      committedAt: "2026-08-15T00:00:01.000Z",
    });
    const record: ScorecardRecord = {
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["run-super", "run-winner", "run-legacy"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord;
    await store.create(record);

    const hydrated = await service.get("sc-1");
    const results = hydrated?.scorecard?.results ?? [];
    // One row per case — the superseded attempt's result is NOT beside the winner's…
    expect(results.map((r) => r.caseId)).toEqual(["aa", "zz"]); // deterministic (caseId, trial) order
    // …and the receipted case serves the RECEIPT's bytes, not the superseded attempt's.
    expect(results.find((r) => r.caseId === "zz")?.snapshot).toMatchObject({ output: "v1" });
    expect(results.find((r) => r.caseId === "aa")?.snapshot).toMatchObject({ output: "v1" });
  });

  // ── DISPLAY COMPATIBILITY IS NOT EVIDENCE (arch-review 47 P1-5) ────────────────────────────────────
  //
  // The per-case membership fallback above exists so a mixed batch still RENDERS every case it ran. A
  // decision must not inherit it: once the batch has a ledger, a case with no receipt is an attempt the
  // batch declined to commit, and weighing it is a release decision standing on a result nobody adopted.
  // A batch with no receipts at all keeps the membership read on both paths — otherwise every pre-ledger
  // comparison would silently become empty rather than honestly legacy.
  it("a decision read serves only the receipted cases of a receipted batch, while the display read still serves the unreceipted one", async () => {
    const { receipts, store, runs, service } = fixtures();
    await runs.create(child("run-receipted", "aa", "succeeded", result("aa", 1)));
    // An attempt the ledger never committed — membership only.
    await runs.create(child("run-uncommitted", "bb", "succeeded", result("bb", 0)));
    await receipts.commit({
      scorecardId: "sc-1",
      caseId: "aa",
      trial: 0,
      childRunId: "run-receipted",
      resultDigest: "d",
      committedAt: "2026-08-15T00:00:01.000Z",
    });
    await store.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["run-receipted", "run-uncommitted"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);

    const shown = await service.get("sc-1");
    expect(shown?.scorecard?.results.map((r) => r.caseId)).toEqual(["aa", "bb"]);
    const decided = await service.getForDecision("sc-1");
    expect(decided?.scorecard?.results.map((r) => r.caseId)).toEqual(["aa"]);
  });

  it("a batch with no receipts at all reads identically for display and for decision — legacy history stays decidable", async () => {
    const { store, runs, service } = fixtures();
    await runs.create(child("run-legacy-a", "aa", "succeeded", result("aa", 1)));
    await runs.create(child("run-legacy-b", "bb", "succeeded", result("bb", 0)));
    await store.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["run-legacy-a", "run-legacy-b"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);

    const shown = await service.get("sc-1");
    const decided = await service.getForDecision("sc-1");
    expect(shown?.scorecard?.results.map((r) => r.caseId)).toEqual(["aa", "bb"]);
    expect(decided?.scorecard).toEqual(shown?.scorecard);
  });

  it("a comparison is computed over the decision read — an uncommitted attempt never becomes a shared case", async () => {
    const { receipts, store, runs, service } = fixtures();
    // Baseline: an embedded (ingest-era) scorecard where both cases passed.
    await store.create({
      id: "sc-base",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      scorecard: { suiteId: "d", harness: "h@1.0.0", results: [result("aa", 1), result("bb", 1)] },
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);
    // Candidate: `aa` committed and passing; `bb` a FAILING attempt the ledger never committed. Read for
    // display it looks like a regression; read as evidence it is not this batch's answer at all.
    await runs.create(child("run-receipted", "aa", "succeeded", result("aa", 1)));
    await runs.create(child("run-uncommitted", "bb", "succeeded", result("bb", 0)));
    await receipts.commit({
      scorecardId: "sc-1",
      caseId: "aa",
      trial: 0,
      childRunId: "run-receipted",
      resultDigest: "d",
      committedAt: "2026-08-15T00:00:01.000Z",
    });
    await store.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["run-receipted", "run-uncommitted"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);

    const diff = await service.diff("acme", "sc-base", "sc-1");
    expect(diff.overlap).toMatchObject({ sharedCases: 1, candidateCases: 1 });
    expect(diff.caseTransitions.map((t) => t.caseId)).not.toContain("bb");
    expect(diff.regressions.map((r) => r.caseId)).not.toContain("bb");
  });

  it("an unreadable receipt ledger fails the read — it never quietly answers the membership question instead", async () => {
    const { store, runs, service, receipts } = fixtures();
    await runs.create(child("run-1", "c1", "succeeded", result("c1", 1)));
    await store.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["run-1"],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } as ScorecardRecord);
    receipts.list = async () => {
      throw new Error("ledger down");
    };
    await expect(service.get("sc-1")).rejects.toThrow(/ledger down/);
  });
});
