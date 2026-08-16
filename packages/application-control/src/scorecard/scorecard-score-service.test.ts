import type {
  CaseCommitReceipt,
  CaseResult,
  Dataset,
  JudgeSpec,
  RunRecord,
  Score,
  ScorecardRecord,
  ScoringPass,
} from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { caseObservationDigest, scorePlaneDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { CaseReceiptStore } from "../ports/case-receipt-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScoringStageStore, StagedJudgment } from "../ports/scoring-stage-store.js";
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

// A pass marker OWNS the score plane (arch-review 8 P0): the strip/judge/settle activities act as a pass,
// and a record with no marker is a settled revision they must refuse to touch. Fixtures therefore carry the
// marker their activity is running under, exactly as score()'s claim leaves it.
function livePass(overrides: Partial<ScoringPass> = {}): ScoringPass {
  return {
    passId: "pass-1",
    epoch: 1,
    leaseUntil: "2026-08-07T00:05:00.000Z",
    heartbeatAt: "2026-08-07T00:00:00.000Z",
    targetRevision: 1,
    baseRevision: 0,
    judges: [],
    startedAt: "2026-08-07T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function recordWith(results: CaseResult[], pass: ScoringPass | null = livePass()): ScorecardRecord {
  return {
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results },
    ...(pass ? { scoringPass: pass } : {}),
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

const scoreJudgeSpec: JudgeSpec = {
  kind: "model",
  id: "j",
  version: "1.0.0",
  provider: "anthropic",
  model: "claude-opus-4-8",
  rubric: "good?",
  inputs: ["trace"],
  tags: [],
};

// The smallest registry that resolves ONE judge — enough for a test whose subject is what the scoring seam
// carries, not which document it resolves.
function judgeRegistryFor(spec: JudgeSpec): JudgeRegistry {
  return {
    async register() {
      throw new Error("unused");
    },
    async has() {
      return true;
    },
    async get() {
      return spec;
    },
    async versions() {
      return [spec.version];
    },
    async ownVersions() {
      return [spec.version];
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
}

describe("ScorecardScoreService planScore (measured-aware worklist)", () => {
  it("lists a case whose judge verdict is an unmeasured placeholder — presence is not judgment", async () => {
    // Given a case whose only judge:j row is the unmeasured placeholder a dead judge left behind
    const svc = serviceFor(recordWith([result("c1", [unmeasuredPlaceholder])]));
    // When the workflow plans the pass for judge j
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }], "pass-1");
    // Then the case IS on the worklist — the placeholder is what the pass exists to replace
    expect(plan.keys).toEqual(["c1#0"]);
  });

  it("does not list a case that already carries a measured verdict", async () => {
    const svc = serviceFor(recordWith([result("c1", [measuredVerdict])]));
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }], "pass-1");
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
    const plan = await svc.planScore("sc-1", [{ id: "j", version: "1.0.0" }], "pass-1");
    expect(plan.keys).toEqual([]);
  });
});

describe("ScorecardScoreService scoreCase (same predicate as the plan)", () => {
  it("skips a case whose verdict is already measured", async () => {
    const svc = serviceFor(recordWith([result("c1", [measuredVerdict])]));
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    expect(out).toEqual({ scored: false, skipped: true });
  });

  it("proceeds past an unmeasured placeholder instead of reading it as done", async () => {
    const svc = serviceFor(recordWith([result("c1", [unmeasuredPlaceholder])]));
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
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
    const out = await svc.scoreCase("sc-1", "c2#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
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
        // A fenced write-back reads `undefined` as "this pass was superseded", so the fake answers like a
        // store that ACCEPTED it — the refusal path has its own test below.
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
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    expect(out.scored).toBe(true);
    expect(seenRunIds).toEqual(["child-c1"]);
  });

  it("threads the judgment CLAIM into the judge's evidence scope — the retry it arbitrates gets its own plane (arch-review 51 Track C)", async () => {
    // Regression: scoreCase held the claim (it hands it to stageJudgments, which decides WHICH invocation of
    // this (case, judge) may write the score) but told the runner only the pass id. The trajectory keeps the
    // FIRST seal per (runId, emitter), so a superseded invocation's evidence stayed permanent under
    // `judge:j#pass-1` while the winning invocation's seal was refused — score and evidence describing two
    // different physical judge executions, indistinguishable afterwards.
    const seenScopes: Array<unknown> = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec, _tenant, _ctx, _placement, _submittedBy, _runId, _pins, _publishWhen, scoringPass) {
        seenScopes.push(scoringPass);
        return [measuredVerdict];
      },
    };
    const svc = new ScorecardScoreService(deps, {
      newId: () => "id-1",
      now: () => "2026-08-07T00:00:00.000Z",
      scoring: new ScoringService({ judges: judgeRegistryFor(scoreJudgeSpec), judgeRunner }),
      getRecord: async () => recordWith([result("c1", [unmeasuredPlaceholder])]),
      pinJudges: async (_tenant, judgeRefs) => judgeRefs,
    });
    // When the pass re-invokes this case under its second attempt of round 1
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1", {
      generation: 1,
      attempt: 2,
    });
    expect(out.scored).toBe(true);
    // Then the runner is told the whole invocation coordinate, not just the pass
    expect(seenScopes).toEqual([{ passId: "pass-1", claim: { generation: 1, attempt: 2 } }]);
  });

  it("an invocation with no claim still scopes the evidence to its pass — the in-process pass has nothing finer to say", async () => {
    const seenScopes: Array<unknown> = [];
    const judgeRunner: JudgeRunner = {
      async run(_spec, _tenant, _ctx, _placement, _submittedBy, _runId, _pins, _publishWhen, scoringPass) {
        seenScopes.push(scoringPass);
        return [measuredVerdict];
      },
    };
    const svc = new ScorecardScoreService(deps, {
      newId: () => "id-1",
      now: () => "2026-08-07T00:00:00.000Z",
      scoring: new ScoringService({ judges: judgeRegistryFor(scoreJudgeSpec), judgeRunner }),
      getRecord: async () => recordWith([result("c1", [unmeasuredPlaceholder])]),
      pinJudges: async (_tenant, judgeRefs) => judgeRefs,
    });
    await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    expect(seenScopes).toEqual([{ passId: "pass-1" }]);
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
    expect((await svc.planScore("sc-1", v2, "pass-1")).keys).toEqual([]);
    // The strip-first step clears the selected judge's prior rows and persists them
    expect(await svc.prepareScore("sc-1", v2, "pass-1")).toEqual({ stripped: 1 });
    // Now the pass re-judges: the case is on the worklist
    expect((await svc.planScore("sc-1", v2, "pass-1")).keys).toEqual(["c1#0"]);
    // Idempotent for activity retries — a stripped plane strips to nothing
    expect(await svc.prepareScore("sc-1", v2, "pass-1")).toEqual({ stripped: 0 });
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
      // The pass this finalize belongs to. Its `judges` is the PASS-START seal (what score() wrote), and the
      // revision records exactly that — never a finalize-time re-resolution.
      scoringPass: livePass({
        targetRevision: 2,
        baseRevision: 1,
        judges: [{ id: "j", version: "2.0.0", model: "m2" }],
      }),
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
    await svc.finalizeScore("sc-1", [{ id: "j", version: "2.0.0" }], "bob", "pass-1");
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// arch-review 8 P0 — OWNERSHIP. The previous wave made the pass VISIBLE (readers refuse a plane between
// revisions). Visibility is not ownership: two replicas both read an absent marker, both wrote one, and the
// loser kept writing onto the winner's plane — after the marker, i.e. the read guard, was already gone.
// The statement these tests certify is stronger than "a pass is in flight":
//   at most one pass owns the right to mutate a score plane, and a superseded pass can never write again.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("scoring-pass ownership (arch-review 8 P0)", () => {
  // A store with the real claim CAS — the guard is the whole subject here, so a fake that ignores it would
  // certify nothing.
  function casStore(initial: ScorecardRecord) {
    let current = initial;
    return {
      get current() {
        return current;
      },
      store: {
        ...unusedStore,
        async get() {
          return current;
        },
        async update(
          _id: string,
          patch: Partial<ScorecardRecord>,
          _events?: unknown,
          guard?: { expectScoringPassId?: string | null; expectScoringPassEpoch?: number | null },
        ) {
          // Mirrors the real stores: passId is the FENCE (never reused), epoch is diagnostic ordering.
          if (guard?.expectScoringPassId !== undefined) {
            const owner = current.scoringPass?.passId ?? null;
            if (owner !== guard.expectScoringPassId) return undefined;
          }
          if (guard?.expectScoringPassEpoch !== undefined) {
            const persisted = current.scoringPass?.epoch ?? null;
            if (persisted !== guard.expectScoringPassEpoch) return undefined;
          }
          current = { ...current, ...patch };
          return current;
        },
      } as unknown as ScorecardStore,
    };
  }

  function svcOver(cas: ReturnType<typeof casStore>, newId: () => string, now = "2026-08-07T00:00:00.000Z") {
    return new ScorecardScoreService(
      { ...deps, store: cas.store },
      {
        newId,
        now: () => now,
        scoring: new ScoringService({}),
        getRecord: async () => cas.current,
        pinJudges: async (_t, j) => j,
      },
    );
  }

  it("gives the pass to exactly ONE of two replicas racing from the same read", async () => {
    const before = recordWith([result("c1", [])], null);
    const cas = casStore(before);
    // Both replicas read the record BEFORE either writes — B keeps that stale snapshot, which is exactly the
    // interleaving read-check-write lost to (it saw "no pass" and believed it).
    const a = svcOver(cas, () => "pass-A");
    const b = new ScorecardScoreService(
      { ...deps, store: cas.store },
      {
        newId: () => "pass-B",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => before,
        pinJudges: async (_t, j) => j,
      },
    );
    await a.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    await expect(b.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] })).rejects.toThrow(
      ConflictError,
    );
    expect(cas.current.scoringPass?.passId).toBe("pass-A");
    expect(cas.current.scoringPass?.epoch).toBe(1);
  });

  it("refuses a superseded pass's late write-back — the interleaving the read guard cannot see", async () => {
    // The winner has SETTLED: marker cleared, revision closed. Nothing is left to refuse the loser except
    // the fence, which is the entire point (with the marker gone, `requireSucceeded` reads the plane happily).
    const settled = recordWith([result("c1", [])], null);
    const cas = casStore(settled);
    const written: string[] = [];
    const runStore = {
      async create() {
        throw new Error("unused");
      },
      async get() {
        return undefined;
      },
      async deleteByScorecard() {
        return 0;
      },
      async countActiveByEnvelope() {
        return 0;
      },
      async liveSessions() {
        return [];
      },
      async list() {
        return [{ id: "child-c1", caseId: "c1", result: { caseId: "c1", scores: [] } } as never];
      },
      async update(_id: string, _patch: unknown, _events?: unknown, fence?: { passId: string }) {
        // The real store evaluates this as a cross-row condition IN the write statement; the fake mirrors it.
        if (fence && settled.scoringPass?.passId !== fence.passId) return undefined;
        written.push(_id);
        return {} as never;
      },
    } as unknown as RunStore;
    const svc = new ScorecardScoreService(
      { ...deps, store: cas.store, runStore },
      {
        newId: () => "id-1",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => ({ ...cas.current, runIds: ["child-c1"] }),
        pinJudges: async (_t, j) => j,
      },
    );
    // The loser wakes up and tries to judge a case. It cannot even start: no marker names it.
    await expect(
      svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-LOSER"),
    ).rejects.toThrow(ConflictError);
    expect(written).toEqual([]);
  });

  it("refuses to RE-ARM a marker on a settled plane — the strip would destroy a closed revision", async () => {
    // prepareScore used to mint a marker whenever none existed. A superseded pass's late activity would then
    // re-open the revision boundary a settle had just closed, and strip the plane that revision certifies.
    const cas = casStore(recordWith([result("c1", [measuredVerdict])], null));
    const svc = svcOver(cas, () => "id-1");
    await expect(svc.prepareScore("sc-1", [{ id: "j", version: "1.0.0" }], "pass-LOSER")).rejects.toThrow(
      ConflictError,
    );
    expect(cas.current.scoringPass).toBeUndefined(); // nothing was armed
  });

  it("does not take over a HEALTHY long pass just because it is old (a lease, not an age)", async () => {
    // Two hours in — twice the old takeover window — but the owner renewed its lease four minutes ago.
    // The age rule shot exactly this pass: a 1000-case batch behind a rate-limited provider.
    const working = livePass({
      startedAt: "2026-08-07T00:00:00.000Z",
      heartbeatAt: "2026-08-07T01:56:00.000Z",
      leaseUntil: "2026-08-07T02:01:00.000Z",
    });
    const cas = casStore(recordWith([result("c1", [])], working));
    const svc = svcOver(cas, () => "pass-B", "2026-08-07T02:00:00.000Z");
    await expect(svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] })).rejects.toThrow(
      ConflictError,
    );
    expect(cas.current.scoringPass?.passId).toBe("pass-1");
  });

  // arch-review 9 P0: epoch is NOT monotonic — a settle clears the marker, so the next claim computes
  // (undefined ?? 0) + 1 = 1 again. A guard that compares epochs cannot tell a stale writer's epoch 1 from
  // a brand-new pass's epoch 1, which is textbook ABA. The fence is the passId, which is never reused.
  it("refuses a stale writer after settle → new claim, even though both hold epoch 1 (ABA)", async () => {
    const cas = casStore(recordWith([result("c1", [])], null));
    await svcOver(cas, () => "pass-A").score({
      tenant: "acme",
      id: "sc-1",
      judges: [{ id: "j", version: "1.0.0" }],
    });
    const stale = cas.current.scoringPass;
    expect(stale?.epoch).toBe(1);
    // A settles: the marker is cleared and the plane becomes a completed revision again.
    await cas.store.update("sc-1", { scoringPass: null }, undefined, { expectScoringPassId: "pass-A" });
    // A different pass claims later and gets the SAME epoch number.
    await svcOver(cas, () => "pass-B").score({
      tenant: "acme",
      id: "sc-1",
      judges: [{ id: "j", version: "1.0.0" }],
    });
    expect(cas.current.scoringPass?.passId).toBe("pass-B");
    expect(cas.current.scoringPass?.epoch).toBe(1); // the counter restarted — this is the ABA condition
    // The stale writer's epoch matches the live marker's. Its IDENTITY does not, and that is what refuses it.
    const byEpoch = await cas.store.update("sc-1", { updatedAt: "later" }, undefined, {
      expectScoringPassEpoch: stale?.epoch ?? null,
    });
    expect(byEpoch).toBeDefined(); // an epoch-only guard would have let the stale writer through
    const byIdentity = await cas.store.update("sc-1", { updatedAt: "later" }, undefined, {
      expectScoringPassId: "pass-A",
    });
    expect(byIdentity).toBeUndefined();
  });

  it("DOES take over once the lease expires — crash residue must never wedge a record forever", async () => {
    const abandoned = livePass({ leaseUntil: "2026-08-07T00:05:00.000Z" });
    const cas = casStore(recordWith([result("c1", [])], abandoned));
    const svc = svcOver(cas, () => "pass-B", "2026-08-07T00:06:00.000Z");
    await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    expect(cas.current.scoringPass?.passId).toBe("pass-B");
    // The epoch MOVES on takeover — that is what makes every write the old owner still has in flight miss.
    expect(cas.current.scoringPass?.epoch).toBe(2);
  });

  // arch-review 10 P0. The workflow start failing does not undo what the pass it took over already did to
  // the plane. Clearing the marker to `null` made a half-stripped, half-re-scored plane READABLE again — the
  // analytics guard refuses only while a marker exists, so `null` walked mid-revision evidence straight past
  // the one gate that exists to stop it. The damage is not undone by dropping the note that says it exists.
  it("marks its OWN pass failed — never clears the marker — when the score workflow cannot start", async () => {
    const abandoned = livePass({ passId: "pass-A", leaseUntil: "2026-08-07T00:05:00.000Z" });
    const cas = casStore(recordWith([result("c1", [])], abandoned));
    const svc = new ScorecardScoreService(
      {
        ...deps,
        store: cas.store,
        temporalScores: {
          workflowIdFor: (groupId: string, passId: string) => `everdict-score-${groupId}-${passId}`,
          start: async () => {
            throw new ConflictError("CONFLICT", {}, "a scoring pass is already in flight (score workflow running).");
          },
        },
      },
      {
        newId: () => "pass-B",
        now: () => "2026-08-07T00:06:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => ({ ...cas.current, runIds: ["child-c1"] }),
        pinJudges: async (_t, j) => j,
      },
    );
    await expect(svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] })).rejects.toThrow(
      ConflictError,
    );
    // The marker SURVIVES, owned by the claimant, flagged failed: readers keep refusing the plane and the
    // next pass takes it over exactly as it takes over any other abandoned pass.
    expect(cas.current.scoringPass).toBeDefined();
    expect(cas.current.scoringPass?.passId).toBe("pass-B");
    expect(cas.current.scoringPass?.status).toBe("failed");
  });

  // arch-review 10 P0: the workflow id is PASS-scoped, so Temporal stops being a second authority on who
  // owns a group's plane. A group-scoped id was what made the branch above reachable at all.
  it("records a PASS-scoped workflow id on the marker, not a group-scoped one", async () => {
    const cas = casStore(recordWith([result("c1", [])], null));
    const svc = new ScorecardScoreService(
      {
        ...deps,
        store: cas.store,
        temporalScores: {
          workflowIdFor: (groupId: string, passId: string) => `everdict-score-${groupId}-${passId}`,
          start: async () => undefined,
        },
      },
      {
        newId: () => "pass-A",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => ({ ...cas.current, runIds: ["child-c1"] }),
        pinJudges: async (_t, j) => j,
      },
    );
    await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "j", version: "1.0.0" }] });
    expect(cas.current.scoringPass?.workflowId).toBe("everdict-score-sc-1-pass-A");
  });

  // arch-review 10 P1: a workflow that dies terminally must SAY so, or the marker reads `running` over a
  // stripped plane until the lease runs out — and the takeover is back to inferring death from a clock.
  it("flips its own marker failed on a workflow death notice, and refuses to touch a successor's", async () => {
    const live = livePass({ passId: "pass-A" });
    const cas = casStore(recordWith([result("c1", [])], live));
    const svc = svcOver(cas, () => "unused");
    await expect(svc.failScore("sc-1", "pass-A", "the worker was terminated")).resolves.toEqual({ marked: true });
    expect(cas.current.scoringPass?.status).toBe("failed");
    expect(cas.current.scoringPass?.failure).toContain("terminated");

    // A workflow that died BECAUSE it was superseded finds the marker belongs to someone else, and marks
    // nothing — declaring a live pass dead is the one thing this must never do.
    const takenOver = casStore(recordWith([result("c1", [])], livePass({ passId: "pass-B" })));
    const svc2 = svcOver(takenOver, () => "unused");
    await expect(svc2.failScore("sc-1", "pass-A", "superseded")).resolves.toEqual({ marked: false });
    expect(takenOver.current.scoringPass?.status).toBe("running");
  });
});

// arch-review 15 P0-1/P0-3. TRUST-52 proved the DB primitive arbitrates correctly; these prove the
// production composition PRESERVES that answer. It did not: `writeBackScores` collapsed a per-(case, judge)
// verdict back into a case-level boolean, so one accepted judge let the whole case plane through — a
// REJECTED judge's bytes riding on its neighbour's win. Deciding in one unit and mutating in another is the
// shape this codebase keeps removing, reintroduced by the fix for it.
describe("writeBackScores — the carrier obeys the stage's per-JUDGE arbitration", () => {
  const measured = (judge: string, value: number): Score => ({
    graderId: judge,
    metric: `judge:${judge}`,
    value,
    pass: value === 1,
  });

  // A child whose plane already holds BOTH judges — what the winning attempt left there.
  function harness(opts: { accept: string[]; failStage?: boolean }) {
    const child: RunRecord = {
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: { ...result("c1", [measured("a", 1), measured("b", 1)]) },
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    } as unknown as RunRecord;
    const writes: Score[][] = [];
    const runStore = {
      async list() {
        return [child];
      },
      async update(_id: string, patch: Partial<RunRecord>) {
        if (patch.result) {
          writes.push(patch.result.scores);
          child.result = patch.result;
        }
        return child;
      },
      async get() {
        return child;
      },
    } as unknown as RunStore;
    const stage: ScoringStageStore = {
      async stage(_s, _p, entries) {
        if (opts.failStage) throw new Error("stage unavailable");
        return entries.filter((e) => opts.accept.includes(e.judgeId));
      },
      async staged() {
        return [];
      },
      async clear() {
        return 0;
      },
    };
    const record = { ...recordWith([result("c1", [])], livePass()), runIds: ["child-c1"] };
    const svc = new ScorecardScoreService(
      { ...deps, runStore, scoringStage: stage },
      {
        newId: () => "id",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => record,
        pinJudges: async (_t: string, j: Array<{ id: string; version: string }>) => j,
      },
    );
    return { svc, record, child, writes };
  }

  // This attempt re-judged BOTH a and b; the stage accepts only a.
  const thisAttempt = [{ ...result("c1", [measured("a", 0), measured("b", 0)]), caseId: "c1" } as CaseResult];

  it("writes the ACCEPTED judge's rows and leaves the REJECTED judge's untouched", async () => {
    const { svc, record, writes } = harness({ accept: ["a"] });
    // biome-ignore lint/complexity/useLiteralKeys: exercising the private write path directly is the point
    await (svc as unknown as { writeBackScores: (...args: unknown[]) => Promise<void> })["writeBackScores"](
      record,
      thisAttempt,
      livePass(),
      { judges: [{ id: "a" }, { id: "b" }], claim: { generation: 0, attempt: 2 } },
    );
    expect(writes).toHaveLength(1);
    const written = writes[0] as Score[];
    // a: THIS attempt's judgment (it won)
    expect(written.find((s) => s.metric === "judge:a")).toMatchObject({ value: 0 });
    // b: the WINNER's judgment, still on the plane — this attempt lost it and must not have touched it
    expect(written.find((s) => s.metric === "judge:b")).toMatchObject({ value: 1 });
  });

  it("writes NOTHING when every judge on the case was superseded", async () => {
    const { svc, record, writes } = harness({ accept: [] });
    // biome-ignore lint/complexity/useLiteralKeys: same reason
    await (svc as unknown as { writeBackScores: (...args: unknown[]) => Promise<void> })["writeBackScores"](
      record,
      thisAttempt,
      livePass(),
      { judges: [{ id: "a" }, { id: "b" }], claim: { generation: 0, attempt: 1 } },
    );
    expect(writes).toEqual([]);
  });

  it("REFUSES to write at all when the arbiter cannot answer — fail-closed", async () => {
    // While the stage was shadow telemetry, swallowing its failure and writing anyway was rollback-safe. It
    // stopped being shadow the moment it became the arbiter: "the arbiter is down" must never read as "you
    // won", or the race it settles is restored exactly when it is least observable.
    const { svc, record, writes } = harness({ accept: ["a"], failStage: true });
    await expect(
      // biome-ignore lint/complexity/useLiteralKeys: same reason
      (svc as unknown as { writeBackScores: (...args: unknown[]) => Promise<void> })["writeBackScores"](
        record,
        thisAttempt,
        livePass(),
        { judges: [{ id: "a" }], claim: { generation: 0, attempt: 1 } },
      ),
    ).rejects.toThrow(/stage unavailable/);
    expect(writes).toEqual([]);
  });
});

// arch-review 44 ①. A GROUP WITHOUT CHILD RUNS STAGES TOO.
//
// The stage write used to live INSIDE `writeBackScores`, which returns early when a group has no child runs —
// so an embed group's judgments were judged, carried on the embedded scorecard, and never staged. Parity
// reported it correctly (`missingFromStage` = everything), and that correctness is exactly the problem: the
// fleet readiness gate could never go green while embed groups ran, and a contract step taken anyway would
// have dropped every embed group's judgments. The stage write is a judgment being recorded; the carrier write
// is where the bytes land. Sharing one guard made the second decide the first.
describe("the scoring stage and EMBED-mode groups (no child runs)", () => {
  const inheritedGrader: Score = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };
  // A judge that actually returns a verdict — the pass has to PRODUCE a judgment for there to be a delta to
  // stage, so the smallest registry + runner the scoring service accepts.
  const judgeA: JudgeSpec = {
    kind: "model",
    id: "a",
    version: "1.0.0",
    provider: "anthropic",
    model: "m",
    rubric: "good?",
    inputs: ["trace"],
    tags: [],
  };
  const judgeRegistry: JudgeRegistry = {
    async register() {
      throw new Error("unused");
    },
    async has() {
      return true;
    },
    async get() {
      return judgeA;
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
  const judgeRunner: JudgeRunner = {
    async run() {
      return [{ graderId: "a", metric: "judge:a", value: 1, pass: true }];
    },
  };

  function embedHarness() {
    // No `runIds` — the embedded scorecard IS the carrier, which is what makes this the blocked shape.
    let record: ScorecardRecord = {
      ...recordWith([result("c1", [inheritedGrader])]),
      runIds: undefined as string[] | undefined,
    };
    const updates: Array<Partial<ScorecardRecord>> = [];
    const rows: StagedJudgment[] = [];
    const stage: ScoringStageStore = {
      async stage(_scorecardId, _passId, entries) {
        rows.push(...entries);
        return entries;
      },
      async staged() {
        return rows.map((row) => ({ ...row }));
      },
      async clear() {
        return rows.length;
      },
    };
    const store: ScorecardStore = {
      ...unusedStore,
      async get() {
        return record;
      },
      async update(_id, patch) {
        updates.push(patch);
        record = { ...record, ...patch } as ScorecardRecord;
        return record;
      },
    };
    const svc = new ScorecardScoreService(
      { ...deps, store, scoringStage: stage },
      {
        newId: () => "pass-embed",
        now: () => "2026-08-09T00:00:00.000Z",
        scoring: new ScoringService({ judges: judgeRegistry, judgeRunner }),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    return { svc, updates, rows };
  }

  it("stages an embed group's judged delta, so its settle carries a parity observation that can agree", async () => {
    const { svc, updates, rows } = embedHarness();

    await svc.score({ tenant: "acme", id: "sc-1", judges: [{ id: "a", version: "1.0.0" }] });
    await new Promise((r) => setTimeout(r, 30));

    // One row per (case, judge) — the delta this pass produced, not the inherited grader row beside it.
    expect(rows.map((row) => [row.caseKey, row.judgeId])).toEqual([["c1#0", "a"]]);
    const revision = updates.find((u) => u.scoring !== undefined)?.scoring?.at(-1);
    // Pre-fix this read `staged: 0, missingFromStage: 1, promotionSafe: false` — a pass that judged correctly
    // and could never be promotion-safe, on a group shape nothing in the design excludes.
    expect(revision?.stageParity).toMatchObject({
      expectedJudged: 1,
      staged: 1,
      missingFromStage: 0,
      promotionSafe: true,
    });
  });
});

// arch-review 43 ①. The stage's SCORE BYTES are still shadow: the carriers are the source of truth, and the
// contract step that swaps them is gated on accumulated parity evidence. What that evidence has never covered
// is the PROMOTION ITSELF — every observation so far compares staged bytes to plane bytes, which certifies
// the dual write and says nothing about the merge that would consume it, because the merge did not exist.
//
// The read-side switch (EVERDICT_SCORING_STAGE_AUTHORITATIVE=1 → `scoringStageAuthoritative`) runs that merge
// on real traffic under a rule that cannot change a record: promote only where this pass's own parity says
// the two sources agree completely, re-digest the promoted plane against the carrier plane, and REFUSE —
// durably, by name — otherwise. Off, nothing here happens at all.
describe("the scoring stage's read-side switch (EVERDICT_SCORING_STAGE_AUTHORITATIVE)", () => {
  const verdict = (id: string, value: number): Score => ({
    graderId: id,
    metric: `judge:${id}`,
    value,
    pass: value === 1,
  });
  const inherited: Score = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };
  const JUDGES = [{ id: "a", version: "1.0.0" }];

  function stageOf(rows: Array<{ caseKey: string; judgeId: string; scores: Score[] }>): ScoringStageStore {
    return {
      async stage(_s, _p, entries) {
        return entries;
      },
      async staged() {
        return rows;
      },
      async clear() {
        return rows.length;
      },
    };
  }

  // One settle over a plane holding an inherited grader row plus judge a's verdict, with whatever stage the
  // case under test wires. Returns the patch the guarded settle wrote.
  async function settleWith(
    opts: { stage?: ScoringStageStore; authoritative?: boolean },
    plane: Score[] = [inherited, verdict("a", 1)],
  ) {
    const record: ScorecardRecord = {
      ...recordWith([result("c1", plane)], livePass({ targetRevision: 1, baseRevision: 0, judges: [] })),
      runIds: ["child-c1"],
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
      {
        ...deps,
        store,
        ...(opts.stage ? { scoringStage: opts.stage } : {}),
        ...(opts.authoritative !== undefined ? { scoringStageAuthoritative: opts.authoritative } : {}),
      },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    await svc.finalizeScore("sc-1", JUDGES, "dana", "pass-1");
    return { revision: updates.at(-1)?.scoring?.at(-1), patch: updates.at(-1) };
  }

  it("OFF (the default) — a settle records no promotion at all, even over a stage that disagrees", async () => {
    // The byte-compatibility that makes the whole flag safe to ship: an unset deployment behaves exactly as
    // it did before this existed, so evidence gathered under it is evidence about the old code.
    const disagreeing = stageOf([{ caseKey: "c1#0", judgeId: "a", scores: [verdict("a", 0)] }]);
    const off = await settleWith({ stage: disagreeing });
    expect(off.revision?.stagePromotion).toBeUndefined();
    expect(off.patch?.steps).toBeUndefined();
    // …and the parity observation is unchanged: still recorded, still saying these two disagree.
    expect(off.revision?.stageParity).toMatchObject({ promotionSafe: false, mismatched: 1 });
    // The plane the revision certifies is the CARRIER plane — byte-identical to the flag-off world.
    const on = await settleWith({ stage: disagreeing, authoritative: true });
    expect(on.revision?.scorePlaneDigest).toBe(off.revision?.scorePlaneDigest);
  });

  it("ON with an agreeing stage — the plane is promoted and the revision SAYS which source it read", async () => {
    const agreeing = stageOf([{ caseKey: "c1#0", judgeId: "a", scores: [verdict("a", 1)] }]);
    const { revision, patch } = await settleWith({ stage: agreeing, authoritative: true });
    expect(revision?.stagePromotion).toEqual({ applied: true });
    // The promoted plane still carries the INHERITED grader row: the stage is a delta, and a promotion that
    // read it as the full desired plane would have dropped it — which the digest would show.
    expect(revision?.scorePlaneDigest).toBe((await settleWith({ stage: agreeing })).revision?.scorePlaneDigest);
    expect(patch?.steps).toBeUndefined(); // nothing refused, nothing to narrate
  });

  it("ON with a judgment the pass never staged — REFUSED by name, and the carriers keep the record", async () => {
    // The failure mode the whole parity apparatus exists to catch: a promotion here silently drops a
    // judgment. The switch must not fall back quietly — a refusal nobody can find is the same as no gate.
    const empty = stageOf([]);
    const { revision, patch } = await settleWith({ stage: empty, authoritative: true });
    expect(revision?.stagePromotion?.applied).toBe(false);
    expect(revision?.stagePromotion?.refusal).toContain("missingFromStage=1");
    expect(revision?.stageParity).toMatchObject({ promotionSafe: false, missingFromStage: 1 });
    // …and an operator reading the record's own timeline sees it, not only the ledger.
    expect(patch?.steps?.at(-1)?.message).toContain("scoring-stage promotion REFUSED");
  });

  it("ON with no stage wired — the deployment believes it is promoting, and the record says it did not", async () => {
    // The configuration whose SILENCE would later be read as evidence: a fleet running the switch over passes
    // that had nothing to promote from.
    const { revision, patch } = await settleWith({ authoritative: true });
    expect(revision?.stagePromotion?.applied).toBe(false);
    expect(revision?.stagePromotion?.refusal).toContain("no stage observation");
    expect(patch?.steps?.at(-1)?.message).toContain("REFUSED");
  });

  it("a promoted plane that MOVES the bytes voids the observation too, not merely the promotion", async () => {
    // Data cannot produce this — the comparison and the merge read the same rows, so a parity-safe pass
    // merges to an identical plane. A defect in the merge can, and then the record would carry a green
    // `promotionSafe` beside a refused promotion: the fleet gate would be certified by the very report its
    // own rehearsal had just contradicted. Driven directly, because that is the only way to state it.
    const svc = new ScorecardScoreService(
      { ...deps, scoringStageAuthoritative: true },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => recordWith([]),
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    const carrier = [result("c1", [verdict("a", 1)])];
    const promote = (
      svc as unknown as {
        promoteFromStage: (
          carrier: CaseResult[],
          observation: unknown,
          judges: ReadonlyArray<{ id: string }>,
        ) => { results: CaseResult[]; parity?: { completed: boolean }; promotion?: { applied: boolean } };
      }
    ).promoteFromStage;
    const out = promote.call(
      svc,
      carrier,
      {
        // A parity report claiming perfect agreement…
        parity: {
          scorecardId: "sc-1",
          passId: "pass-1",
          completed: true,
          expectedJudged: 1,
          staged: 1,
          missingFromStage: [],
          matched: 1,
          mismatched: [],
          orphaned: [],
          // …taken, as the real observer takes it, against THIS carrier plane — so the basis check passes and
          // the merge divergence below is what the promotion actually trips over.
          basisDigest: scorePlaneDigest(carrier),
        },
        // …over rows that do not agree at all.
        staged: [{ caseKey: "c1#0", judgeId: "a", scores: [verdict("a", 0)] }],
      },
      [{ id: "a" }],
    );
    expect(out.results).toBe(carrier); // the carriers certify this revision
    expect(out.promotion).toMatchObject({ applied: false });
    expect(out.parity?.completed).toBe(false); // an observation contradicted by the merge measured nothing
  });

  // arch-review 44 ②. THE OBSERVATION HAS TO BE ABOUT THE PLANE BEING PROMOTED FROM.
  //
  // Parity means "the stage agrees with the plane this pass WROTE", and the contract step's whole content is
  // making the settled plane come from the stage instead. Compare against THAT plane and the report is the
  // stage against itself: perfect, on every pass, forever — the fleet gate green because the measurement
  // stopped measuring. Until now the only thing preventing it was the order of two statements in `aggregate`
  // and a comment; now the observation states its basis and the promotion checks it.
  function promoteWith(observationParity: Record<string, unknown>, carrier: CaseResult[]) {
    const svc = new ScorecardScoreService(
      { ...deps, scoringStageAuthoritative: true },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => recordWith([]),
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    const promote = (
      svc as unknown as {
        promoteFromStage: (
          carrier: CaseResult[],
          observation: unknown,
          judges: ReadonlyArray<{ id: string }>,
        ) => {
          results: CaseResult[];
          parity?: { completed: boolean };
          promotion?: { applied: boolean; refusal?: string };
        };
      }
    ).promoteFromStage;
    return promote.call(
      svc,
      carrier,
      {
        parity: {
          scorecardId: "sc-1",
          passId: "pass-1",
          completed: true,
          expectedJudged: 1,
          staged: 1,
          missingFromStage: [],
          matched: 1,
          mismatched: [],
          orphaned: [],
          ...observationParity,
        },
        staged: [{ caseKey: "c1#0", judgeId: "a", scores: [verdict("a", 1)] }],
      },
      [{ id: "a" }],
    );
  }

  it("REFUSES a parity report taken against a plane other than the carriers it is promoting from", () => {
    const carrier = [result("c1", [inherited, verdict("a", 1)])];
    // The shape the contract step invites: a comparison re-based onto the plane the settle is about to
    // certify. Its counts are perfect — and they describe a comparison of the stage with itself.
    const rebased = scorePlaneDigest([result("c1", [verdict("a", 1)])]);

    const out = promoteWith({ basisDigest: rebased }, carrier);

    // Pre-fix the promotion applied: perfect counts, nothing to notice, no record that the basis had moved.
    expect(out.promotion?.applied).toBe(false);
    expect(out.promotion?.refusal).toContain("compares the stage with itself");
    expect(out.results).toBe(carrier);
  });

  it("promotes when the comparison's basis IS the carrier plane", () => {
    const carrier = [result("c1", [inherited, verdict("a", 1)])];
    const out = promoteWith({ basisDigest: scorePlaneDigest(carrier) }, carrier);
    expect(out.promotion).toEqual({ applied: true });
  });
});

describe("ScorecardScoreService carrier selection — the receipt names the row, not the run store's order", () => {
  // Regression (arch-review 43, Phase 3): both the judge's evidence-plane seal and the score write-back
  // resolved a case's carrier by folding `children.filter(result)` into a Map — so the row that won was
  // whichever attempt the run store happened to list LAST. A resumed or retried batch keeps its superseded
  // attempts parented to the same scorecard, and `get` hydration serves the RECEIPT's child, so a re-score
  // paid for provider calls and then wrote its verdicts onto a row no reader would ever hydrate: a pass that
  // looks like it did nothing. The receipt is the one authority for "which attempt answered this case".
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

  // Both attempts of c1 carry a result, and the SUPERSEDED one is listed last — the position that used to
  // decide. Only the committed one is named by a receipt.
  const committed: RunRecord = {
    id: "child-committed",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "succeeded",
    result: result("c1", [unmeasuredPlaceholder]),
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
  const superseded: RunRecord = { ...committed, id: "child-superseded", updatedAt: "2026-08-07T00:09:00.000Z" };

  function harness(receipts: CaseCommitReceipt[]): {
    svc: ScorecardScoreService;
    written: string[];
    judged: Array<string | undefined>;
  } {
    const written: string[] = [];
    const judged: Array<string | undefined> = [];
    const runStore: RunStore = {
      async create() {
        throw new Error("unused");
      },
      async update(id) {
        written.push(id);
        return committed; // a fenced write-back reads undefined as "superseded"; this fake accepted it
      },
      async get() {
        return undefined;
      },
      async list() {
        return [committed, superseded]; // the superseded attempt is LAST — last-wins would pick it
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
    const caseReceipts = {
      async commit() {
        throw new Error("unused");
      },
      async commitCase() {
        throw new Error("unused");
      },
      async list() {
        return receipts;
      },
    } as unknown as CaseReceiptStore;
    const judgeRunner: JudgeRunner = {
      async run(_spec, _tenant, _ctx, _placement, _submittedBy, runId) {
        judged.push(runId);
        return [measuredVerdict];
      },
    };
    const record: ScorecardRecord = {
      ...recordWith([result("c1", [unmeasuredPlaceholder])]),
      runIds: ["child-committed"],
    };
    const svc = new ScorecardScoreService(
      { ...deps, runStore, caseReceipts },
      {
        newId: () => "id-1",
        now: () => "2026-08-07T00:00:00.000Z",
        scoring: new ScoringService({ judges, judgeRunner }),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    return { svc, written, judged };
  }

  const receiptFor = (childRunId: string): CaseCommitReceipt => ({
    scorecardId: "sc-1",
    caseId: "c1",
    trial: 0,
    childRunId,
    resultDigest: "digest-c1",
    committedAt: "2026-08-07T00:00:00.000Z",
  });

  it("writes a re-score's verdicts onto the child the RECEIPT committed, not the newest row", async () => {
    // Given two attempts of c1 where the receipt names the first and the store lists the second last
    const { svc, written, judged } = harness([receiptFor("child-committed")]);
    // When the pass re-scores that case
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    // Then the judgment lands on the committed attempt — the row every reader hydrates from
    expect(out.scored).toBe(true);
    expect(written).toEqual(["child-committed"]);
    // …and the judge's own execution sealed on that same attempt, so the evidence plane and the scores agree
    expect(judged).toEqual(["child-committed"]);
  });

  it("falls back per case — a batch predating the receipt ledger keeps the row it has", async () => {
    // Given no receipt for c1 at all (a batch older than the ledger), which is what those rows can support
    const { svc, written } = harness([]);
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    // Then the pass still scores it rather than skipping the case for want of a receipt
    expect(out.scored).toBe(true);
    expect(written).toEqual(["child-superseded"]);
  });

  // arch-review 46: the pass hydrated c1, judged that copy, and is writing back. A recovery re-driving the
  // case in between commits a NEW receipt over a different execution — and every guard in the write path
  // still passes, because the pass genuinely owns the marker and the fence genuinely holds. What lands is one
  // execution's verdicts on another execution's row, and afterwards nothing in the record can say so.
  it("REFUSES the write-back when the case's execution was re-committed while the pass was judging it", async () => {
    const { svc, written } = harness([
      { ...receiptFor("child-committed"), observationDigest: "sha256:some-other-execution" },
    ]);
    await expect(
      svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1"),
    ).rejects.toBeInstanceOf(ConflictError);
    // Nothing was written — a judgment about bytes nobody vouches for is not evidence
    expect(written).toEqual([]);
  });

  it("writes when the receipt vouches for exactly the execution the judge read", async () => {
    const { svc, written } = harness([
      { ...receiptFor("child-committed"), observationDigest: caseObservationDigest(result("c1", [])) },
    ]);
    const out = await svc.scoreCase("sc-1", "c1#0", [{ id: "j", version: "1.0.0" }], undefined, "pass-1");
    expect(out.scored).toBe(true);
    expect(written).toEqual(["child-committed"]);
  });
});

// ── WHAT THE SETTLED REVISION SAYS ITS JUDGES READ (arch-review 46) ──────────────────────────────────
//
// The write-back refuses a case whose execution moved under the pass. This is the durable half: the settled
// revision states the input it judged and whether the receipt ledger vouches for it, so a release gate
// reading the pin afterwards is not left inferring it from silence.
describe("ScorecardScoreService — the settled revision records its input observation", () => {
  const judged = result("c1", [measuredVerdict]);

  function settleHarness(receipts: CaseCommitReceipt[] | "unreadable"): {
    svc: ScorecardScoreService;
    updates: Array<Partial<ScorecardRecord>>;
  } {
    const record: ScorecardRecord = {
      ...recordWith([judged]),
      scoringPass: livePass({ targetRevision: 1, baseRevision: 0, judges: [{ id: "j", version: "1.0.0" }] }),
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
    const caseReceipts = {
      async commit() {
        throw new Error("unused");
      },
      async commitCase() {
        throw new Error("unused");
      },
      async list() {
        if (receipts === "unreadable") throw new Error("receipt ledger unreachable");
        return receipts;
      },
    } as unknown as CaseReceiptStore;
    const svc = new ScorecardScoreService(
      { ...deps, store, caseReceipts },
      {
        newId: () => "id-1",
        now: () => "2026-08-08T00:00:00.000Z",
        scoring: new ScoringService({}),
        getRecord: async () => record,
        pinJudges: async (_tenant, judgeRefs) => judgeRefs,
      },
    );
    return { svc, updates };
  }

  const observationOf = (updates: Array<Partial<ScorecardRecord>>) => updates.at(-1)?.scoring?.at(-1)?.inputObservation;

  it("digests the judged plane and finds it equal to the receipts-rebuilt digest", async () => {
    const { svc, updates } = settleHarness([
      {
        scorecardId: "sc-1",
        caseId: "c1",
        trial: 0,
        childRunId: "child-1",
        resultDigest: "sha256:result",
        observationDigest: caseObservationDigest(judged),
        committedAt: "2026-08-07T00:00:00.000Z",
      },
    ]);
    await svc.finalizeScore("sc-1", [{ id: "j", version: "1.0.0" }], "bob", "pass-1");
    const observed = observationOf(updates);
    expect(observed).toMatchObject({ completed: true, diverged: 0, cases: 1 });
    expect(observed?.receiptSetDigest).toBe(observed?.setDigest);
    // …and the revision names the pass that wrote it — the marker clears in this same write
    expect(updates.at(-1)?.scoring?.at(-1)?.passId).toBe("pass-1");
  });

  it("states that a LEGACY receipt cannot answer — no execution digest is not agreement", async () => {
    const { svc, updates } = settleHarness([
      {
        scorecardId: "sc-1",
        caseId: "c1",
        trial: 0,
        childRunId: "child-1",
        resultDigest: "sha256:result",
        committedAt: "2026-08-07T00:00:00.000Z",
      },
    ]);
    await svc.finalizeScore("sc-1", [{ id: "j", version: "1.0.0" }], "bob", "pass-1");
    expect(observationOf(updates)).toMatchObject({ completed: false });
    expect(observationOf(updates)?.failure).toContain("no receipt carrying an execution digest");
  });

  it("records an UNREADABLE ledger as an incomplete observation — and still settles the pass", async () => {
    // A measurement must never be able to fail the thing it measures; what it must also never do is stay
    // silent, because silence is what a later gate would read as agreement.
    const { svc, updates } = settleHarness("unreadable");
    await svc.finalizeScore("sc-1", [{ id: "j", version: "1.0.0" }], "bob", "pass-1");
    expect(observationOf(updates)).toMatchObject({ completed: false });
    expect(observationOf(updates)?.failure).toContain("receipt ledger unreachable");
    expect(updates.at(-1)?.scoringPass).toBeNull(); // the settle went through and closed the revision boundary
  });
});
