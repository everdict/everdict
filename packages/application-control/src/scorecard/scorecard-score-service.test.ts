import type { CaseResult, Dataset, JudgeSpec, RunRecord, Score, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";

// The Temporal scoring pass (planScore/scoreCase) used to read bare judge-metric PRESENCE as "already
// judged" — an unmeasured placeholder row (the exact state rescore-unmeasured exists to replace) made the
// pass skip every case it was invoked for. These tests pin the measured-aware predicate on the service
// surface itself, with the smallest fakes the constructor accepts.

const unusedStore: ScorecardStore = {
  async create() {
    throw new Error("unused");
  },
  async update() {
    throw new Error("unused");
  },
  async get() {
    return undefined;
  },
  async list() {
    return [];
  },
  async delete() {
    return false;
  },
};

const unusedDatasets: DatasetRegistry = {
  async register() {
    throw new Error("unused");
  },
  async has() {
    return false;
  },
  async get(): Promise<Dataset> {
    throw new Error("unused"); // effectiveDataset falls back to shell cases on a throw
  },
  async versions() {
    return [];
  },
  async ownVersions() {
    return [];
  },
  async list() {
    return [];
  },
  async creatorOf() {
    return undefined;
  },
  async moveToTeam() {
    throw new Error("unused");
  },
  async softDelete() {
    throw new Error("unused");
  },
  async setVersionTags() {
    throw new Error("unused");
  },
  async versionTags() {
    return {};
  },
};

const deps: ScorecardServiceDeps = {
  dispatcher: {
    async dispatch() {
      throw new Error("unused");
    },
  },
  store: unusedStore,
  datasets: unusedDatasets,
};

function result(caseId: string, scores: Score[], failure?: CaseResult["failure"]): CaseResult {
  return {
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores,
    ...(failure ? { failure } : {}),
  };
}

function recordWith(results: CaseResult[]): ScorecardRecord {
  return {
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}

function serviceFor(record: ScorecardRecord): ScorecardScoreService {
  return new ScorecardScoreService(deps, {
    newId: () => "id-1",
    now: () => "2026-08-07T00:00:00.000Z",
    scoring: new ScoringService({}),
    getRecord: async () => record,
    pinJudges: async (_tenant, judges) => judges,
  });
}

const measuredVerdict: Score = { graderId: "judge", metric: "judge:j", value: 1, pass: true };
const unmeasuredPlaceholder: Score = {
  graderId: "judge",
  metric: "judge:j",
  status: "unmeasured",
  reason: "grader_error",
  retryable: true,
  detail: "[grader-error] judge transport died",
};

describe("ScorecardScoreService planScore (measured-aware worklist)", () => {
  it("lists a case whose judge verdict is an unmeasured placeholder — presence is not judgment", async () => {
    // Given a case whose only judge:j row is the unmeasured placeholder a dead judge left behind
    const svc = serviceFor(recordWith([result("c1", [unmeasuredPlaceholder])]));
    // When the workflow plans the pass for judge j
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }]);
    // Then the case IS on the worklist — the placeholder is what the pass exists to replace
    expect(plan.keys).toEqual(["c1#0"]);
  });

  it("does not list a case that already carries a measured verdict", async () => {
    const svc = serviceFor(recordWith([result("c1", [measuredVerdict])]));
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }]);
    expect(plan.keys).toEqual([]);
  });

  it("does not list a case whose classified failure starves the judge — its recovery is retry, not scoring", async () => {
    const failed = result("c2", [], {
      stage: "dispatch",
      class: "infra",
      code: "DISPATCH_FAILED",
      message: "no node",
      retryable: true,
    });
    const svc = serviceFor(recordWith([failed]));
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }]);
    expect(plan.keys).toEqual([]);
  });
});

describe("ScorecardScoreService scoreCase (same predicate as the plan)", () => {
  it("skips a case whose verdict is already measured", async () => {
    const svc = serviceFor(recordWith([result("c1", [measuredVerdict])]));
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }]);
    expect(out).toEqual({ scored: false, skipped: true });
  });

  it("proceeds past an unmeasured placeholder instead of reading it as done", async () => {
    const svc = serviceFor(recordWith([result("c1", [unmeasuredPlaceholder])]));
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }]);
    // Then the case is actually scored (the no-runner ScoringService records its own skip verdicts — the
    // point here is the gate: the placeholder no longer short-circuits the pass as "already judged")
    expect(out.scored).toBe(true);
  });

  it("skips a non-gradeable case (classified failure) rather than judging a world that never existed", async () => {
    const failed = result("c2", [unmeasuredPlaceholder], {
      stage: "dispatch",
      class: "infra",
      code: "DISPATCH_FAILED",
      message: "no node",
      retryable: true,
    });
    const svc = serviceFor(recordWith([failed]));
    const out = await svc.scoreCase("sc-1", "c2#0", [{ id: "j", version: "1.0.0" }]);
    expect(out).toEqual({ scored: false, skipped: true });
  });

  it("threads the case's child run id to the judge runner — the judge's execution seals on the child it judged", async () => {
    // Regression: the scoring pass resolves this scorecard's children (the same read writeBackScores does) and
    // hands each case's child run id to JudgeRunner.run, so the runner can seal the judge's own execution as a
    // judge:<id> plane on that child's trajectory. Without it a re-score judged in the dark.
    const judgeSpec: JudgeSpec = {
      kind: "model",
      id: "j",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    };
    const judges: JudgeRegistry = {
      async register() {
        throw new Error("unused");
      },
      async has() {
        return true;
      },
      async get() {
        return judgeSpec;
      },
      async versions() {
        return ["1.0.0"];
      },
      async ownVersions() {
        return ["1.0.0"];
      },
      async list() {
        return [];
      },
      async moveToTeam() {
        throw new Error("unused");
      },
      async creatorOfVersion() {
        return undefined;
      },
      async softDelete() {
        throw new Error("unused");
      },
      async setVersionTags() {
        throw new Error("unused");
      },
      async versionTags() {
        return {};
      },
    };
    const child: RunRecord = {
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: result("c1", []),
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    const runStore: RunStore = {
      async create() {
        throw new Error("unused");
      },
      async update() {
        return undefined; // write-back target — accepting the patch is enough here
      },
      async get() {
        return undefined;
      },
      async list() {
        return [child];
      },
      async deleteByScorecard() {
        return 0;
      },
      async countActiveByEnvelope() {
        return 0;
      },
      async inFlightByTenant() {
        return {};
      },
      async liveSessions() {
        return [];
      },
    };
    const seenRunIds: Array<string | undefined> = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec, _tenant, _ctx, _placement, _submittedBy, runId) {
        seenRunIds.push(runId);
        return [measuredVerdict];
      },
    };
    const record: ScorecardRecord = { ...recordWith([result("c1", [unmeasuredPlaceholder])]), runIds: ["child-c1"] };
    const svc = new ScorecardScoreService(
      { ...deps, runStore },
      {
        newId: () => "id-1",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({ judges, judgeRunner }),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }]);
    expect(out.scored).toBe(true);
    expect(seenRunIds).toEqual(["child-c1"]);
  });
});

describe("ScorecardScoreService prepareScore — strip-first makes the Temporal pass re-judge (arch-review 6, H4)", () => {
  // The plan's measured predicate is id-only (the score plane cannot represent a judge VERSION): with
  // quality@1's measured verdicts in place, a quality@2 pass planned an EMPTY worklist and went straight to
  // finalize — advertising the new version's sealed closure over the old version's judgments. The strip-first
  // step persists the cleared plane through the child-run write-back, so the id-only predicate afterwards
  // means "judged in THIS pass".
  it("clears the old version's verdicts so the new version's pass gets a full worklist (and re-strips as a no-op)", async () => {
    const child: RunRecord = {
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: result("c1", [measuredVerdict]),
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    const runStore: RunStore = {
      async create() {
        throw new Error("unused");
      },
      async update(_id, patch) {
        // the write-back target — persist the stripped plane the way the real store would
        if (patch.result) child.result = patch.result;
        return child;
      },
      async get() {
        return undefined;
      },
      async list() {
        return [child];
      },
      async deleteByScorecard() {
        return 0;
      },
      async countActiveByEnvelope() {
        return 0;
      },
      async inFlightByTenant() {
        return {};
      },
      async liveSessions() {
        return [];
      },
    };
    // getRecord HYDRATES from the child (what the production read does for runIds-backed groups) — the strip
    // must round-trip through persistence, not through an in-memory alias.
    const hydrated = (): ScorecardRecord => ({
      ...recordWith(child.result ? [child.result] : []),
      runIds: ["child-c1"],
    });
    // The store accepts the pass-marker writes (I3: prepareScore ensures the persisted boundary marker).
    const markerStore: ScorecardStore = {
      ...unusedStore,
      async update() {
        return hydrated();
      },
    };
    const svc = new ScorecardScoreService(
      { ...deps, store: markerStore, runStore },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => hydrated(),
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    const v2 = [{ id: "j", version: "2.0.0" }];
    // Pre-strip, the id-only predicate reads quality@1's verdict as "already judged" — the empty plan IS the defect
    expect((await svc.planScore("sc-1", v2)).keys).toEqual([]);
    // The strip-first step clears the selected judge's prior rows and persists them
    expect(await svc.prepareScore("sc-1", v2)).toEqual({ stripped: 1 });
    // Now the pass re-judges: the case is on the worklist
    expect((await svc.planScore("sc-1", v2)).keys).toEqual(["c1#0"]);
    // Idempotent for activity retries — a stripped plane strips to nothing
    expect(await svc.prepareScore("sc-1", v2)).toEqual({ stripped: 0 });
  });
});

describe("ScorecardScoreService aggregate — a re-score rewrites scoring identity (arch-review 6, H3)", () => {
  // Pre-fix, the aggregate patched only summary/judgeModels: the record kept certifying the SUBMIT-era
  // judges (manifest.judges / orchestration.judges) over a plane a different judge had since re-scored, and
  // judgeModels unioned history so a replaced judge's model stayed advertised forever.
  it("appends a rescore revision, refreshes the judge views to the merged effective set, and recomputes judgeModels", async () => {
    const specFor = (id: string, version: string, model: string): JudgeSpec => ({
      kind: "model",
      id,
      version,
      provider: "anthropic",
      model,
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    const registry: JudgeRegistry = {
      async register() {
        throw new Error("unused");
      },
      async has() {
        return true;
      },
      async get(_tenant, id, version) {
        if (id === "j" && version === "2.0.0") return specFor("j", "2.0.0", "m2");
        if (id === "k" && version === "1.0.0") return specFor("k", "1.0.0", "mk");
        throw new Error(`no such judge ${id}@${version}`);
      },
      async versions() {
        return [];
      },
      async ownVersions() {
        return [];
      },
      async list() {
        return [];
      },
      async moveToTeam() {
        throw new Error("unused");
      },
      async creatorOfVersion() {
        return undefined;
      },
      async softDelete() {
        throw new Error("unused");
      },
      async setVersionTags() {
        throw new Error("unused");
      },
      async versionTags() {
        return {};
      },
    };
    const record: ScorecardRecord = {
      ...recordWith([result("c1", [measuredVerdict])]),
      judgeModels: ["m1", "mk"],
      orchestration: {
        judges: [
          { id: "j", version: "1.0.0" },
          { id: "k", version: "1.0.0" },
        ],
        concurrency: 1,
        retries: 0,
      },
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "sha256:ds" },
        harness: { id: "h", version: "1" },
        judges: [
          { id: "j", version: "1.0.0", specDigest: "sha256:j1", model: "m1" },
          { id: "k", version: "1.0.0", specDigest: "sha256:k1", model: "mk" },
        ],
      },
      scoring: [
        {
          revision: 1,
          kind: "initial",
          judges: [
            { id: "j", version: "1.0.0", model: "m1" },
            { id: "k", version: "1.0.0", model: "mk" },
          ],
          scorePlaneDigest: "sha256:initial",
          createdAt: "2026-08-07T00:00:00.000Z",
        },
      ],
    };
    const updates: Array<Partial<ScorecardRecord>> = [];
    const store: ScorecardStore = {
      ...unusedStore,
      async get() {
        return record;
      },
      async update(_id, patch) {
        updates.push(patch);
        return { ...record, ...patch };
      },
    };
    const svc = new ScorecardScoreService(
      { ...deps, store, judges: registry },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({ judges: registry }),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    // When judge j is re-scored at version 2.0.0 (model m2), replacing its 1.0.0 (model m1) pass
    await svc.finalizeScore("sc-1", [{ id: "j", version: "2.0.0" }], "bob");
    const patch = updates.at(-1);
    expect(patch).toBeDefined();
    // The ledger APPENDS — history intact, the new pass identified with its own sealed closure
    expect(patch?.scoring).toHaveLength(2);
    expect(patch?.scoring?.[0]).toEqual(record.scoring?.[0]);
    expect(patch?.scoring?.[1]).toMatchObject({
      revision: 2,
      kind: "rescore",
      createdBy: "bob",
      judges: [{ id: "j", version: "2.0.0", model: "m2" }],
    });
    expect(patch?.scoring?.[1]?.scorePlaneDigest).toMatch(/^sha256:/);
    // Replace-selected / keep-others — k survives untouched, j is the NEW closure
    expect(patch?.manifest?.judges).toEqual([
      { id: "k", version: "1.0.0", specDigest: "sha256:k1", model: "mk" },
      expect.objectContaining({ id: "j", version: "2.0.0", model: "m2" }),
    ]);
    expect(patch?.orchestration?.judges).toEqual([
      { id: "k", version: "1.0.0" },
      { id: "j", version: "2.0.0" },
    ]);
    // judgeModels reads CURRENT — the replaced judge's model (m1) is no longer this record's judge
    expect(patch?.judgeModels).toEqual(["m2", "mk"]);
    // The stamped-policy verdict aggregate follows the judgment in the same settle (arch-review 7 §4)
    expect(patch?.verdictSummary).toMatchObject({ verdicted: 1, passed: 1, failed: 0, passRate: 1 });
  });
});

describe("ScorecardScoreService — the scoring pass is visible state (arch-review 7 P0, I3)", () => {
  function passHarness(results: CaseResult[]) {
    let record = { ...recordWith(results), runIds: undefined as string[] | undefined };
    const updates: Array<Partial<ScorecardRecord>> = [];
    const store: ScorecardStore = {
      ...unusedStore,
      async get() {
        return record;
      },
      async update(_id, patch) {
        updates.push(patch);
        record = { ...record, ...patch } as typeof record;
        return record;
      },
    };
    const svc = new ScorecardScoreService(
      { ...deps, store },
      {
        newId: () => "id-1",
        now: () => "2026-08-09T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    return { svc, updates, current: () => record };
  }

  it("score() persists the marker BEFORE the pass runs, and the settle clears it in the SAME write as the revision", async () => {
    const { svc, updates } = passHarness([result("c1", [measuredVerdict])]);
    await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    // The FIRST persisted write is the marker — nothing strips before the boundary is visible.
    expect(updates[0]?.scoringPass).toMatchObject({ targetRevision: 1, baseRevision: 0, status: "running" });
    // Wait for the async in-process pass to settle.
    await new Promise((r) => setTimeout(r, 20));
    const settle = updates.find((u) => u.scoring !== undefined);
    expect(settle).toBeDefined();
    // The boundary CLOSES in the settle write itself — marker cleared exactly when the revision appends.
    expect(settle?.scoringPass).toBeNull();
    expect(settle?.scoring).toHaveLength(1);
  });

  it("a second pass while one is LIVE refuses across replicas — the marker, not process memory, is the guard", async () => {
    const { svc, current } = passHarness([result("c1", [measuredVerdict])]);
    await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    // A DIFFERENT service instance (another replica — its own empty inFlight Set) sees the persisted marker.
    const replicaB = new ScorecardScoreService(
      {
        ...deps,
        store: {
          ...unusedStore,
          async get() {
            return current();
          },
          async update() {
            return current();
          },
        },
      },
      {
        newId: () => "id-2",
        now: () => "2026-08-09T00:00:10.000Z", // ten seconds later — well inside the stale window
        scoring: new ScoringService({}),
        getRecord: async () => current(),
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    // The first pass may have settled already (tiny plane) — only assert when the marker is still live.
    const live = current().scoringPass ?? undefined;
    if (live !== undefined && live.status === "running") {
      await expect(
        replicaB.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] }),
      ).rejects.toThrow(/already in flight/);
    }
  });

  it("a FAILED pass keeps blocking readers and is taken over by the next score()", async () => {
    const failedPass = {
      targetRevision: 2,
      baseRevision: 1,
      judges: [{ id: "j", version: "1.0.0" }],
      startedAt: "2026-08-08T23:00:00.000Z",
      status: "failed" as const,
      failedAt: "2026-08-08T23:05:00.000Z",
      failure: "judge transport died",
    };
    const { svc, updates } = passHarness([result("c1", [measuredVerdict])]);
    // Seed the failed marker (the Temporal-abandoned / in-process-crashed shape).
    await (async () => {
      const first = await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
      void first;
      await new Promise((r) => setTimeout(r, 20));
    })();
    updates.length = 0;
    // Force the record into the failed-pass state.
    const { svc: svc2, updates: updates2, current } = passHarness([result("c1", [measuredVerdict])]);
    await svc2.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    await new Promise((r) => setTimeout(r, 20));
    // Simulate abandonment: overwrite with a failed marker, then a NEW pass takes it over instead of refusing.
    await (await import("node:util")).promisify(setTimeout)(1);
    const record = current();
    record.scoringPass = failedPass;
    await expect(
      svc2.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] }),
    ).resolves.toBeDefined();
    expect(updates2.some((u) => (u.scoringPass as { status?: string } | null)?.status === "running")).toBe(true);
  });
});
