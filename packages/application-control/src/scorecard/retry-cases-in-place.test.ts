import type { CaseResult, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCaseReceiptStore } from "../ports/case-receipt-store.js";
import { RetryCasesInPlace, type RetryCasesSupport } from "./retry-cases-in-place.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";

// ── THE PASS REFUSES BEFORE IT DISPATCHES ────────────────────────────────────────────────────────────
//
// Every assertion here is about something the pass must NOT do. The happy path is proved by the store and
// receipt suites (the claim CAS against a real Postgres, the supersession against it too); what a service
// test owns is the order of its refusals, because each one guards an effect that cannot be taken back:
// dispatching a case costs compute and money, and superseding a verdict rewrites what a batch says.

const result = (caseId: string, over: Partial<CaseResult> = {}): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
  scores: [],
  ...over,
});
const decided = (caseId: string, pass: boolean): CaseResult =>
  result(caseId, { scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }] });
const infraDead = (caseId: string): CaseResult =>
  result(caseId, {
    failure: { code: "DISPATCH_FAILED", message: "no capacity", stage: "dispatch", class: "infra", retryable: true },
  });

const record = (over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1.0.0" },
    status: "succeeded",
    scorecard: { harness: "h@1.0.0", suiteId: "d", results: [infraDead("c1"), decided("c2", false)] },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  }) as ScorecardRecord;

const harness = (rec: ScorecardRecord | undefined, over: Partial<RetryCasesSupport> = {}) => {
  const dispatched: string[] = [];
  let stored = rec;
  const deps = {
    store: {
      async get() {
        return stored;
      },
      async update(_id: string, patch: Partial<ScorecardRecord>) {
        if (stored === undefined) return undefined;
        stored = { ...stored, ...patch };
        return { ...stored };
      },
    },
    caseReceipts: new InMemoryCaseReceiptStore(),
  } as unknown as ScorecardBatchDeps;
  const pass = new RetryCasesInPlace(deps, {
    now: () => "2026-09-04T01:00:00.000Z",
    newId: () => "p-1",
    runCase: async (id, caseId, trial) => {
      dispatched.push(caseId);
      void id;
      void trial;
      return { settled: true };
    },
    ...over,
  });
  return { pass, dispatched, current: () => stored };
};

describe("RetryCasesInPlace — what it refuses, and in which order", () => {
  it("refuses an empty case list rather than claiming a pass for no work", async () => {
    const { pass, current } = harness(record());
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [] })).rejects.toThrow(/at least one case/i);
    expect(current()?.executionPass).toBeUndefined();
  });

  it("answers 404 for another workspace's scorecard — the same answer the read gives", async () => {
    const { pass } = harness(record({ tenant: "other" }));
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] })).rejects.toThrow(/not found/i);
  });

  it("refuses a batch that is still running — a retry repairs a settled plane", async () => {
    const { pass, dispatched } = harness(record({ status: "running" }));
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] })).rejects.toThrow(/still running/i);
    expect(dispatched).toEqual([]);
  });

  it("refuses a case the batch never sealed — a retry may not ADD a case", async () => {
    // Appending would put a case the manifest never covered into the record, with the dataset decided by a
    // retry. Refused before the claim, so no marker is written for work that cannot run.
    const { pass, dispatched, current } = harness(record());
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "ghost" }] })).rejects.toThrow(
      /not in this batch/i,
    );
    expect(dispatched).toEqual([]);
    expect(current()?.executionPass).toBeUndefined();
  });

  it("refuses to replace a DECIDED case with no reason, and dispatches nothing", async () => {
    const { pass, dispatched } = harness(record());
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c2" }] })).rejects.toThrow(/reason/i);
    // The refusal is worth nothing if the compute was already spent.
    expect(dispatched).toEqual([]);
  });

  it("allows the same retry WITH a reason, and records it on the revision", async () => {
    const { pass, dispatched, current } = harness(record());
    await pass.run({
      tenant: "acme",
      id: "sc-1",
      cases: [{ caseId: "c2" }],
      reason: "flaky fixture",
      submittedBy: "alice",
    });
    expect(dispatched).toEqual(["c2"]);
    const revision = current()?.executions?.[0];
    expect(revision).toMatchObject({ revision: 1, kind: "retry", reason: "flaky fixture", createdBy: "alice" });
  });

  it("needs NO reason for a case that never produced a measurement", async () => {
    // The motivating case: an infrastructure death measured nothing, so replacing it destroys no evidence.
    const { pass, dispatched } = harness(record());
    await pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] });
    expect(dispatched).toEqual(["c1"]);
  });

  it("refuses while another pass is live — two retries must not own one plane", async () => {
    const live = record({
      executionPass: {
        passId: "p-0",
        targetRevision: 1,
        baseRevision: 0,
        cases: [{ caseId: "c1" }],
        startedAt: "2026-09-04T00:30:00.000Z",
        status: "running",
      },
    });
    const { pass, dispatched } = harness(live);
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] })).rejects.toThrow(
      /already in flight/i,
    );
    expect(dispatched).toEqual([]);
  });

  it("leaves the marker FAILED when a case throws — a dead pass is addressable, a cleared one is not", async () => {
    const { pass, current } = harness(record(), {
      runCase: async () => {
        throw new Error("the runtime went away");
      },
    });
    await expect(pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] })).rejects.toThrow(
      /runtime went away/,
    );
    // Cleared, it would be indistinguishable from a pass that never ran; left `running`, nothing could ever
    // claim the record again.
    expect(current()?.executionPass).toMatchObject({ passId: "p-1", status: "failed" });
    expect(current()?.executions ?? []).toEqual([]);
  });

  it("clears the marker in the SAME write that appends the revision", async () => {
    const { pass, current } = harness(record());
    await pass.run({ tenant: "acme", id: "sc-1", cases: [{ caseId: "c1" }] });
    // The revision boundary: while the marker stands the plane belongs to no completed revision, so a
    // settle that appended the revision and cleared the marker separately would publish a readable plane
    // that no revision covers.
    expect(current()?.executionPass).toBeNull();
    expect(current()?.executions).toHaveLength(1);
  });
});
