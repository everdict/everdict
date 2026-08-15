import { InMemoryCaseReceiptStore, RunService, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The receipt-canonical case↔run map, over HTTP (arch-review 44). Both transports of the same fact:
// `GET /scorecards/:id` carries the (case, trial) → child map so a screen never pairs rows with runs by
// position, and `GET /runs?scorecardId=` labels each attempt with the batch's verdict on it, so a superseded
// run is still listed (it is real history) but can never be read as the case's answer.

const dispatcher: Dispatcher = {
  async dispatch(): Promise<CaseResult> {
    throw new Error("not under test");
  },
};

const result = (caseId: string, value: number, trial?: number): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "prompt", output: `v${value}` },
  scores: [{ metric: "pass", graderId: "g", value, pass: value > 0 }],
  ...(trial !== undefined ? { trial } : {}),
});

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

// One batch, one case, two attempts: the committed one is OLDER than the attempt it superseded — the shape
// where "the last child by createdAt" and "the receipted child" disagree.
async function build() {
  const receipts = new InMemoryCaseReceiptStore();
  const store = new InMemoryScorecardStore();
  const runs = new InMemoryRunStore();
  runs.attachScorecards(store);
  await runs.create(child("run-committed", "c1", "2026-08-15T00:00:01.000Z", result("c1", 1)));
  await runs.create(child("run-superseded", "c1", "2026-08-15T00:00:09.000Z"));
  // A second case with no receipt at all — a batch straddling the ledger's deployment.
  await runs.create(child("run-legacy", "c2", "2026-08-15T00:00:02.000Z", result("c2", 1)));
  await receipts.commit({
    scorecardId: "sc-1",
    caseId: "c1",
    trial: 0,
    childRunId: "run-committed",
    resultDigest: "d",
    committedAt: "2026-08-15T00:00:10.000Z",
  });
  await store.create({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1.0.0" },
    status: "succeeded",
    runIds: ["run-committed", "run-superseded", "run-legacy"],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  } as ScorecardRecord);
  const scorecardService = new ScorecardService({
    dispatcher,
    store,
    runStore: runs,
    caseReceipts: receipts,
    datasets: { get: async () => ({ id: "d", version: "1", cases: [], tags: [] }) },
  } as never);
  return buildServer({
    service: new RunService({ dispatcher, store: runs }),
    scorecardService,
  });
}

const tenant = { "x-everdict-tenant": "acme" };

describe("GET /scorecards/:id — the case↔run map rides the detail", () => {
  it("names the RECEIPTED child for a retried case, not the newest attempt", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/scorecards/sc-1", headers: tenant });
    expect(res.statusCode).toBe(200);
    // Only the receipted case is answered for — c2 has no receipt, so the map says nothing about it rather
    // than guessing (the client's own fallback owns that case).
    expect(res.json().caseRuns).toEqual([{ caseId: "c1", trial: 0, runId: "run-committed" }]);
    await app.close();
  });
});

describe("GET /runs?scorecardId= — every attempt carries the batch's verdict on it", () => {
  it("labels the receipted attempt canonical and its superseded sibling not — the list served them indistinguishable", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/runs?scorecardId=sc-1", headers: tenant });
    expect(res.statusCode).toBe(200);
    const byId = new Map<string, { canonical?: boolean }>(
      res.json().map((r: { id: string; canonical?: boolean }) => [r.id, r]),
    );
    expect(byId.get("run-committed")?.canonical).toBe(true);
    expect(byId.get("run-superseded")?.canonical).toBe(false);
    // The superseded attempt is still LISTED — it is execution history, not a row to hide.
    expect(byId.size).toBe(3);
    await app.close();
  });

  it("leaves a case the ledger never committed unlabelled — absent is 'unknown', and unknown is not superseded", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/runs?scorecardId=sc-1", headers: tenant });
    const legacy = res.json().find((r: { id: string }) => r.id === "run-legacy");
    expect(legacy).toBeDefined();
    expect("canonical" in legacy).toBe(false);
    await app.close();
  });

  it("does not annotate the standalone activity list — canonicality is a question only a batch's children have", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/runs?scope=all", headers: tenant });
    for (const row of res.json()) expect("canonical" in row).toBe(false);
    await app.close();
  });
});
