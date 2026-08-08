import { BadRequestError, type CaseResult, ConflictError } from "@everdict/contracts";
import { RunRecordSchema, type ScorecardRecord, ScorecardRecordSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { newScorecardChildRun, newSeededScorecardChildRun } from "../run/scorecard-child.js";
import { SPANS_TO_EVENTS_VERSION } from "../trace/spans-to-events.js";
import { ScorecardBatch } from "./scorecard-batch.js";
import { verdictPolicyRef } from "./verdict-policy.js";

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
  it("carries the owning team onto the record — a factory that drops it leaves every batch unowned", () => {
    // The route resolves the owner and hands it in; a field the factory does not copy is silently lost, and the
    // whole team axis then reads as "nobody's" no matter what the store or the list filter do.
    expect(queued({ teamId: "team-eng" }).teamId).toBe("team-eng");
    expect(queued().teamId).toBeUndefined(); // ...and absent stays absent (unowned = the workspace's)
    expect(
      ScorecardBatch.newQueuedIngest({
        id: "sc2",
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        teamId: "team-eng",
        now: NOW,
      }).teamId,
    ).toBe("team-eng");
  });

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

  it("newChildRun materializes a QUEUED fan-out child (trigger=scorecard, no caseSpec) — waiting for a runner, not falsely running", () => {
    const child = newScorecardChildRun({
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
      // Born queued (like a standalone run) — a fan-out parked behind one runner reads as "waiting" until leased,
      // then flipped to running by the onStarted hook. It carries no caseSpec (the batch re-plans from its dataset).
      status: "queued",
      trigger: "scorecard",
      parentScorecardId: "sc1",
      runtime: "nomad-a",
    });
    expect(child.caseSpec).toBeUndefined(); // the batch re-plans from its dataset — children carry no case body
  });

  it("newSeededChildRun materializes a carried-over result as an already-succeeded child keyed by the result's caseId", () => {
    const seeded = newSeededScorecardChildRun({
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
  it("isTerminal is true exactly for succeeded, failed, superseded, and cancelled", () => {
    expect(ScorecardBatch.from(queued()).isTerminal()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).isTerminal()).toBe(false);
    for (const status of ["succeeded", "failed", "superseded", "cancelled"] as const) {
      expect(ScorecardBatch.from({ ...queued(), status }).isTerminal()).toBe(true);
    }
  });

  it("canCancel is true exactly while unsettled (queued or running), false once terminal", () => {
    expect(ScorecardBatch.from(queued()).canCancel()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).canCancel()).toBe(true);
    for (const status of ["succeeded", "failed", "superseded", "cancelled"] as const) {
      expect(ScorecardBatch.from({ ...queued(), status }).canCancel()).toBe(false);
    }
  });

  it("canDelete is the mirror of canCancel — only a terminal batch may be deleted (stop a live one first)", () => {
    expect(ScorecardBatch.from(queued()).canDelete()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).canDelete()).toBe(false);
    for (const status of ["succeeded", "failed", "superseded", "cancelled"] as const) {
      expect(ScorecardBatch.from({ ...queued(), status }).canDelete()).toBe(true);
    }
  });

  it("assertCanDelete throws a ConflictError on a live batch, pointing at cancel as the way out", () => {
    expect(() => ScorecardBatch.from({ ...queued(), status: "running" }).assertCanDelete()).toThrow(
      /stop it \(cancel\) before deleting/,
    );
    expect(() => ScorecardBatch.from({ ...queued(), status: "succeeded" }).assertCanDelete()).not.toThrow();
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

  it("canRerun accepts any finished batch including multi-trial (submit re-fans the trials), rejects unfinished/dead-end", () => {
    expect(ScorecardBatch.from({ ...queued(), status: "succeeded" }).canRerun()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "failed" }).canRerun()).toBe(true);
    // Unlike retry-failed, a multi-trial batch IS re-runnable — a full re-run re-fans every trial.
    const multiTrial = queued({ orchestration: { judges: [], concurrency: 4, retries: 1, trials: 3 } });
    expect(ScorecardBatch.from({ ...multiTrial, status: "succeeded" }).canRerun()).toBe(true);
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).canRerun()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "superseded" }).canRerun()).toBe(false);
    expect(ScorecardBatch.from({ ...queued(), status: "cancelled" }).canRerun()).toBe(false);
  });

  it("assertCanRerun throws a 400 for a batch that has not finished", () => {
    expect(() => ScorecardBatch.from({ ...queued(), status: "running" }).assertCanRerun()).toThrow(
      /Only a finished batch can be re-run/,
    );
    expect(() => ScorecardBatch.from({ ...queued(), status: "queued" }).assertCanRerun()).toThrow(BadRequestError);
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

describe("ScorecardBatch — transitions (guard, then return {patch, facts})", () => {
  it("start moves a queued or running batch to running; a terminal batch rejects it with ConflictError", () => {
    expect(ScorecardBatch.from(queued()).start("t1")).toEqual({
      patch: { status: "running", updatedAt: "t1" },
      facts: [],
    });
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).start("t1")).toEqual({
      patch: { status: "running", updatedAt: "t1" },
      facts: [],
    });
    expect(() => ScorecardBatch.from({ ...queued(), status: "superseded" }).start("t1")).toThrow(ConflictError);
  });

  it("succeed and fail stamp the terminal status plus the outcome extras verbatim", () => {
    const summary = [{ metric: "tests-pass", count: 1, mean: 1, passRate: 1 }];
    const live = ScorecardBatch.from({ ...queued(), status: "running" });
    // A terminal patch also DATES its own interpretation: which span→event projection the verdicts were
    // computed under (N6). Stamped here rather than by a caller, so no settle path can omit it.
    expect(live.succeed({ summary, runIds: ["r1"] }, "t2").patch).toEqual({
      status: "succeeded",
      summary,
      runIds: ["r1"],
      traceProjectionVersion: SPANS_TO_EVENTS_VERSION,
      verdictPolicy: verdictPolicyRef(), // the terminal patch also dates WHICH policy decided its verdicts
      updatedAt: "t2",
    });
    expect(live.fail({ code: "INTERNAL", message: "boom", phase: "judges" }, { steps: [] }, "t2").patch).toEqual({
      status: "failed",
      error: { code: "INTERNAL", message: "boom", phase: "judges" },
      steps: [],
      traceProjectionVersion: SPANS_TO_EVENTS_VERSION,
      verdictPolicy: verdictPolicyRef(),
      updatedAt: "t2",
    });
  });

  it("succeed/fail emit the completion fact — passRate pointer included; machine-fired announces without personal targeting (E2 widening)", () => {
    const summary = [{ metric: "tests-pass", count: 2, mean: 0.5, passRate: 0.5 }];
    const initiated = ScorecardBatch.from({ ...queued({ createdBy: "alice" }), status: "running" });
    expect(initiated.succeed({ summary }, "t2").facts).toEqual([
      {
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "sc1" },
        actor: "alice",
        payload: { status: "succeeded", dataset: "d@1.0.0", harness: "h@1", passRate: 0.5 },
      },
    ]);
    // A bare failure (no extras.summary) falls back to the record's persisted summary — the notification gate's exact read.
    const failed = initiated.fail({ code: "INTERNAL", message: "boom" }, {}, "t2").facts;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "scorecard.failed", payload: { status: "failed" } });
    // Machine-fired (no createdBy): the completion still announces (the Mattermost consumer posts it), but
    // with nobody to bell — no actor/recipient, so the feed consumer skips it.
    const machine = ScorecardBatch.from({ ...queued(), status: "running" }).succeed({ summary }, "t2").facts[0];
    expect(machine?.kind).toBe("scorecard.completed");
    expect(machine?.actor).toBeUndefined();
  });

  it("every terminal state rejects succeed/fail/start/supersede/cancel — first terminal write wins", () => {
    for (const status of ["succeeded", "failed", "superseded", "cancelled"] as const) {
      const settled = ScorecardBatch.from({ ...queued(), status });
      expect(() => settled.succeed({}, "t")).toThrow(ConflictError);
      expect(() => settled.fail({ code: "INTERNAL", message: "late" }, {}, "t")).toThrow(ConflictError);
      expect(() => settled.start("t")).toThrow(ConflictError);
      expect(() => settled.supersede("sc-new", "t")).toThrow(ConflictError);
      expect(() => settled.cancel("t")).toThrow(ConflictError);
    }
  });

  it("cancel stops a live batch with the CANCELLED error and emits the cancelled fact (born at the transition)", () => {
    const live = ScorecardBatch.from({ ...queued({ createdBy: "alice" }), status: "running" });
    expect(live.cancel("t3")).toEqual({
      patch: {
        status: "cancelled",
        error: { code: "CANCELLED", message: "Stopped by user" },
        updatedAt: "t3",
      },
      facts: [
        {
          kind: "scorecard.cancelled",
          subject: { type: "scorecard", id: "sc1" },
          actor: "alice",
          payload: { status: "cancelled", dataset: "d@1.0.0", harness: "h@1" },
        },
      ],
    });
    // No initiator: the fact still fires (anyone watching the batch cares), just unaddressed.
    const anonymous = ScorecardBatch.from(queued()).cancel("t3");
    expect(anonymous.patch).toMatchObject({ status: "cancelled" });
    expect(anonymous.facts).toHaveLength(1);
    expect(anonymous.facts[0]).not.toHaveProperty("actor");
  });

  it("supersede reclaims a live batch with the SUPERSEDED error naming the replacement — silently (no fact)", () => {
    const live = ScorecardBatch.from({ ...queued({ createdBy: "alice" }), status: "running" });
    expect(live.supersede("sc-new", "t3")).toEqual({
      patch: {
        status: "superseded",
        error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-new)" },
        updatedAt: "t3",
      },
      facts: [],
    });
  });

  it("settleAborted legally re-writes an already-superseded record with the partial outcome, but never a settled one", () => {
    const reclaimed = ScorecardBatch.from({ ...queued(), status: "superseded" });
    expect(reclaimed.settleAborted({ runIds: ["r1"] }, "t4")).toEqual({
      patch: { status: "superseded", runIds: ["r1"], updatedAt: "t4" },
      facts: [],
    });
    // Also legal mid-race from a still-running record (supersede status write and abort are not atomic).
    expect(ScorecardBatch.from({ ...queued(), status: "running" }).settleAborted({}, "t4").patch).toMatchObject({
      status: "superseded",
    });
    for (const status of ["succeeded", "failed"] as const) {
      expect(() => ScorecardBatch.from({ ...queued(), status }).settleAborted({}, "t4")).toThrow(ConflictError);
    }
  });

  it("settleAborted PRESERVES a cancelled record's status (user stop settles as cancelled, not superseded)", () => {
    const cancelled = ScorecardBatch.from({ ...queued({ createdBy: "alice" }), status: "cancelled" });
    // No fact either — the cancelled fact already fired when the stop was requested (cancel()).
    expect(cancelled.settleAborted({ runIds: ["r1"] }, "t4")).toEqual({
      patch: { status: "cancelled", runIds: ["r1"], updatedAt: "t4" },
      facts: [],
    });
  });

  it("rescore re-writes the aggregate over a succeeded group, promotes an experiment, and emits scorecard.scored", () => {
    const summary = [{ metric: "judge:quality", count: 1, mean: 1, passRate: 1 }];
    const experiment = ScorecardBatch.from({
      ...queued({ createdBy: "alice", kind: "experiment" }),
      status: "succeeded",
    });
    const t = experiment.rescore({ summary }, { actor: "bob" }, "t5");
    expect(t.patch).toEqual({ kind: "scorecard", summary, updatedAt: "t5" }); // promoted — the kind flips explicitly
    expect(t.facts).toEqual([
      {
        kind: "scorecard.scored",
        subject: { type: "scorecard", id: "sc1" },
        actor: "bob", // the RE-SCORER, not the original creator
        payload: { status: "succeeded", dataset: "d@1.0.0", harness: "h@1", passRate: 1, promoted: true },
      },
    ]);
    // A real scorecard re-scores without a kind flip.
    const plain = ScorecardBatch.from({ ...queued(), status: "succeeded" }).rescore({ summary }, {}, "t5");
    expect(plain.patch).toEqual({ summary, updatedAt: "t5" });
    expect(plain.facts[0]?.payload).not.toHaveProperty("promoted");
    // Only a succeeded group can be scored — anything else is a conflict.
    for (const status of ["queued", "running", "failed", "cancelled", "superseded"] as const) {
      expect(() => ScorecardBatch.from({ ...queued(), status }).rescore({}, {}, "t5")).toThrow(ConflictError);
    }
  });

  it("creationFacts records the submitted fact with the case count and origin provenance", () => {
    const record = queued({
      createdBy: "alice",
      origin: { source: "schedule", scheduleId: "sch_1" },
    });
    expect(ScorecardBatch.creationFacts(record, 3)).toEqual([
      {
        kind: "scorecard.submitted",
        subject: { type: "scorecard", id: "sc1" },
        actor: "alice",
        payload: {
          status: "queued",
          dataset: "d@1.0.0",
          harness: "h@1",
          cases: 3,
          origin: "schedule",
          scheduleId: "sch_1",
        },
      },
    ]);
  });
});

describe("ScorecardBatch — pure derivations and the child-seed helper", () => {
  it("latestChildPerCase dedups to the newest child per case (a batch resumed more than once has several children per case)", () => {
    const child = (id: string, caseId: string, updatedAt: string) => ({
      ...newScorecardChildRun({
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

describe("ScorecardBatch child runs — the universal-run shape (P0)", () => {
  it("stamps every fan-out child as an eval-kind batch-class task inside the scorecard's group", () => {
    const child = newScorecardChildRun({
      id: "run-1",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c1",
      parentScorecardId: "sc-9",
      runtime: "nomad-x",
      origin: { cause: "schedule", scheduleId: "sch-1" },
      now: "2026-07-29T00:00:00.000Z",
    });
    expect(child).toMatchObject({
      kind: "eval",
      class: "batch", // fan-out never competes with a human's click
      lifetime: "task",
      group: { id: "sc-9", role: "case" }, // generalizes parentScorecardId (which stays for the eval surfaces)
      origin: { cause: "schedule", scheduleId: "sch-1" },
      placement: { where: "runtime", target: "nomad-x" },
    });
    expect(child.parentScorecardId).toBe("sc-9"); // the legacy axis is untouched
  });

  it("childRunOrigin maps the batch's free-string source onto the structured cause vocabulary", () => {
    expect(ScorecardBatch.childRunOrigin({ origin: { source: "schedule", scheduleId: "sch-1" } })).toEqual({
      cause: "schedule",
      scheduleId: "sch-1",
    });
    expect(ScorecardBatch.childRunOrigin({ origin: { source: "github-actions" } })).toEqual({ cause: "ci" });
    expect(ScorecardBatch.childRunOrigin({ origin: { source: "web" }, createdBy: "alice" })).toEqual({
      cause: "member",
      actor: "alice",
    });
    // Direct API / unknown source: honest "api", with the actor when one is known.
    expect(ScorecardBatch.childRunOrigin({ createdBy: "bot" })).toEqual({ cause: "api", actor: "bot" });
    // P3: a run-caused batch (an agent submitted it) outranks the source mapping — the children join the
    // demand graph as the agent run's downstream work (the edge the P4 gate and cascade cancel walk).
    expect(
      ScorecardBatch.childRunOrigin({
        origin: { source: "mcp", causedByRunId: "run-a1" },
        createdBy: "alice",
      }),
    ).toEqual({ cause: "run", causedByRunId: "run-a1", actor: "alice" });
  });
});
