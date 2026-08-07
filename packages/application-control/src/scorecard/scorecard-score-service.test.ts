import type { CaseResult, Dataset, Score, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";
import type { ScorecardServiceDeps } from "./scorecard-shared.js";

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
  value: 0,
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
});
