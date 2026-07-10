import { BadRequestError, type CaseResult, ConflictError } from "@everdict/core";
import { RunRecordSchema, type ScorecardRecord, ScorecardRecordSchema } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { ScorecardBatch } from "./scorecard-batch.js";

const NOW = "2026-07-10T00:00:00.000Z";

const result = (caseId: string, trial?: number): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
  ...(trial !== undefined ? { trial } : {}),
});

function queued(overrides: Partial<Parameters<typeof ScorecardBatch.newQueued>[0]> = {}): ScorecardRecord {
  return ScorecardBatch.newQueued({
    id: "sc1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    orchestration: { judges: [], concurrency: 4, retries: 1 },
    now: NOW,
    ...overrides,
  });
}

describe("ScorecardBatch — factories", () => {
  it("newQueued assembles a schema-valid queued batch record with the full re-drive envelope", () => {
    const record = queued({
      origin: { source: "github-actions", repo: "acme/app", prNumber: 7 },
      createdBy: "alice",
      runtime: "nomad-a,k8s-b",
      subset: { total: 3, selected: 2, limit: 2 },
    });
    expect(() => ScorecardRecordSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({
      status: "queued",
      createdBy: "alice",
      runtime: "nomad-a,k8s-b",
      subset: { total: 3, selected: 2 },
      orchestration: { judges: [], concurrency: 4, retries: 1 },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("newQueuedIngest assembles a schema-valid queued record deliberately WITHOUT orchestration (not resumable)", () => {
    const record = ScorecardBatch.newQueuedIngest({
      id: "sc-ing",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      createdBy: "bob",
      now: NOW,
    });
    expect(() => ScorecardRecordSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({ status: "queued", createdBy: "bob" });
    expect(record.orchestration).toBeUndefined();
    expect(record.runtime).toBeUndefined();
  });

  it("newChildRun materializes a running fan-out child (trigger=scorecard, no caseSpec) — not a queued standalone run", () => {
    const child = ScorecardBatch.newChildRun({
      id: "r1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      parentScorecardId: "sc1",
      runtime: "nomad-a",
      now: NOW,
    });
    expect(() => RunRecordSchema.parse(child)).not.toThrow();
    expect(child).toMatchObject({
      status: "running",
      trigger: "scorecard",
      parentScorecardId: "sc1",
      runtime: "nomad-a",
    });
    expect(child.caseSpec).toBeUndefined(); // the batch re-plans from its dataset — children carry no case body
  });

  it("newSeededChildRun materializes a carried-over result as an already-succeeded child keyed by the result's caseId", () => {
    const seeded = ScorecardBatch.newSeededChildRun({
      id: "r2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      result: result("c2"),
      parentScorecardId: "sc1",
      now: NOW,
    });
    expect(() => RunRecordSchema.parse(seeded)).not.toThrow();
    expect(seeded).toMatchObject({ status: "succeeded", caseId: "c2", trigger: "scorecard" });
    expect(seeded.result?.caseId).toBe("c2");
  });
});

describe("ScorecardBatch — guards (the SSOT for legality)", () => {
  it("isTerminal is true exactly for succeeded, failed, and superseded", () => {
    expect(ScorecardBatch.from(queued()).isTerminal()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).isTerminal()).toBe(false);
    for (const status of ["succeeded", "failed", "superseded"] as const) {
      expect(ScorecardBatch.from({ ...queued(), status }).isTerminal()).toBe(true);
    }
  });

  it("canResume requires an unsettled status AND persisted orchestration inputs", () => {
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).canResume()).toBe(true);
    expect(ScorecardBatch.from(queued()).canResume()).toBe(true);
    // Pre-orchestration (legacy) record — keeps the INTERRUPTED tombstone path.
    const { orchestration: _dropped, ...legacy } = queued();
    expect(ScorecardBatch.from({ ...legacy, status: "running" }).canResume()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "succeeded" }).canResume()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "superseded" }).canResume()).toBe(false);
  });

  it("canRetryFailed is false on a non-finished batch (running, superseded) and on a multi-trial batch", () => {
    expect(ScorecardBatch.from({ ...queued(), status: "succeeded" }).canRetryFailed()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "failed" }).canRetryFailed()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).canRetryFailed()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "superseded" }).canRetryFailed()).toBe(false);
    const multiTrial = queued({ orchestration: { judges: [], concurrency: 4, retries: 1, trials: 3 } });
    expect(ScorecardBatch.from({ ...multiTrial, status: "succeeded" }).canRetryFailed()).toBe(false);
  });

  it("assertCanRetryFailed throws the route's exact 400s — unfinished and multi-trial", () => {
    expect(() => ScorecardBatch.from({ ...queued(), status: "running" }).assertCanRetryFailed()).toThrow(
      /Only a finished batch can be retried/,
    );
    expect(() => ScorecardBatch.from({ ...queued(), status: "running" }).assertCanRetryFailed()).toThrow(
      BadRequestError,
    );
    const multiTrial = queued({ orchestration: { judges: [], concurrency: 4, retries: 1, trials: 3 } });
    expect(() => ScorecardBatch.from({ ...multiTrial, status: "failed" }).assertCanRetryFailed()).toThrow(
      /multi-trial \(pass@k\) batch is not yet supported/,
    );
  });

  it("canSupersede matches the (repo, prNumber) provenance case-insensitively and only while unsettled", () => {
    const origin = { source: "github-actions", repo: "Acme/App", prNumber: 7 };
    const live = ScorecardBatch.from({ ...queued({ origin }), status: "running" });
    expect(live.canSupersede({ repo: "acme/app", prNumber: 7 })).toBe(true);
    expect(live.canSupersede({ repo: "acme/app", prNumber: 8 })).toBe(false); // a different PR
    expect(live.canSupersede({ repo: "acme/other", prNumber: 7 })).toBe(false);
    expect(
      ScorecardBatch.from({ ...queued(), status: "running" }).canSupersede({ repo: "acme/app", prNumber: 7 }),
    ).toBe(
      false, // no origin — merge/dev fires never supersede
    );
    expect(
      ScorecardBatch.from({ ...queued({ origin }), status: "succeeded" }).canSupersede({
        repo: "acme/app",
        prNumber: 7,
      }),
    ).toBe(false);
  });

  it("isWorkflowOwned / isMultiTrial / isSuperseded read the orchestration and status axes", () => {
    const wf = queued({ orchestration: { judges: [], concurrency: 1, retries: 0, workflowId: "wf-1" } });
    expect(ScorecardBatch.from(wf).isWorkflowOwned()).toBe(true);
    expect(ScorecardBatch.from(queued()).isWorkflowOwned()).toBe(false);
    const trials = queued({ orchestration: { judges: [], concurrency: 1, retries: 0, trials: 5 } });
    expect(ScorecardBatch.from(trials).isMultiTrial()).toBe(true);
    expect(ScorecardBatch.from(queued()).isMultiTrial()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "superseded" }).isSuperseded()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "failed" }).isSuperseded()).toBe(false);
  });
});

describe("ScorecardBatch — transitions (guard, then return the store patch)", () => {
  it("start moves a queued or running batch to running; a terminal batch rejects it with ConflictError", () => {
    expect(ScorecardBatch.from(queued()).start("t1")).toEqual({ status: "running", updatedAt: "t1" });
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).start("t1")).toEqual({
      status: "running",
      updatedAt: "t1",
    });
    expect(() => ScorecardBatch.from({ ...queued(), status: "superseded" }).start("t1")).toThrow(ConflictError);
  });

  it("succeed and fail stamp the terminal status plus the outcome extras verbatim", () => {
    const summary = [{ metric: "tests-pass", count: 1, mean: 1, passRate: 1 }];
    const live = ScorecardBatch.from({ ...queued(), status: "running" });
    expect(live.succeed({ summary, runIds: ["r1"] }, "t2")).toEqual({
      status: "succeeded",
      summary,
      runIds: ["r1"],
      updatedAt: "t2",
    });
    expect(live.fail({ code: "INTERNAL", message: "boom", phase: "judges" }, { steps: [] }, "t2")).toEqual({
      status: "failed",
      error: { code: "INTERNAL", message: "boom", phase: "judges" },
      steps: [],
      updatedAt: "t2",
    });
  });

  it("every terminal state rejects succeed/fail/start/supersede — first terminal write wins", () => {
    for (const status of ["succeeded", "failed", "superseded"] as const) {
      const settled = ScorecardBatch.from({ ...queued(), status });
      expect(() => settled.succeed({}, "t")).toThrow(ConflictError);
      expect(() => settled.fail({ code: "INTERNAL", message: "late" }, {}, "t")).toThrow(ConflictError);
      expect(() => settled.start("t")).toThrow(ConflictError);
      expect(() => settled.supersede("sc-new", "t")).toThrow(ConflictError);
    }
  });

  it("supersede reclaims a live batch with the SUPERSEDED error naming the replacement", () => {
    const live = ScorecardBatch.from({ ...queued(), status: "running" });
    expect(live.supersede("sc-new", "t3")).toEqual({
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-new)" },
      updatedAt: "t3",
    });
  });

  it("settleSuperseded legally re-writes an already-superseded record with the partial outcome, but never a settled one", () => {
    const reclaimed = ScorecardBatch.from({ ...queued(), status: "superseded" });
    expect(reclaimed.settleSuperseded({ runIds: ["r1"] }, "t4")).toEqual({
      status: "superseded",
      runIds: ["r1"],
      updatedAt: "t4",
    });
    // Also legal mid-race from a still-running record (supersede status write and abort are not atomic).
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).settleSuperseded({}, "t4")).toMatchObject({
      status: "superseded",
    });
    for (const status of ["succeeded", "failed"] as const) {
      expect(() => ScorecardBatch.from({ ...queued(), status }).settleSuperseded({}, "t4")).toThrow(ConflictError);
    }
  });
});

describe("ScorecardBatch — pure derivations and the child-seed helper", () => {
  it("latestChildPerCase dedups to the newest child per case (a batch resumed more than once has several children per case)", () => {
    const child = (id: string, caseId: string, updatedAt: string) => ({
      ...ScorecardBatch.newChildRun({
        id,
        tenant: "acme",
        harness: { id: "h", version: "1" },
        caseId,
        parentScorecardId: "sc1",
        now: "2026-07-10T00:00:00.000Z",
      }),
      updatedAt,
    });
    const latest = ScorecardBatch.latestChildPerCase([
      child("old-c1", "c1", "2026-07-10T00:00:01.000Z"),
      child("new-c1", "c1", "2026-07-10T00:00:05.000Z"),
      child("only-c2", "c2", "2026-07-10T00:00:02.000Z"),
    ]);
    expect(latest.size).toBe(2);
    expect(latest.get("c1")?.id).toBe("new-c1");
    expect(latest.get("c2")?.id).toBe("only-c2");
  });

  it("withTrialSummary derives the pass@k roll-up only when the scorecard actually holds trials", () => {
    const single = {
      ...queued(),
      status: "succeeded" as const,
      scorecard: { suiteId: "d", harness: "h@1", results: [result("c1")] },
    };
    expect(ScorecardBatch.from(single).withTrialSummary()).toBe(single); // no trials → the record is returned as-is

    const trialed = {
      ...single,
      scorecard: { suiteId: "d", harness: "h@1", results: [result("c1", 0), result("c1", 1)] },
    };
    const derived = ScorecardBatch.from(trialed).withTrialSummary();
    expect(derived.trialSummary).toMatchObject({ cases: 1, maxTrials: 2 });
  });
});
