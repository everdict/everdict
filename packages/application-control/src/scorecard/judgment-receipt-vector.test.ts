import type { CaseResult, Dataset, JudgeSpec, Score, ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { type JudgmentClaim, type ScoringStageStore, claimSupersedes } from "../ports/scoring-stage-store.js";
import type { StagedJudgment } from "../ports/scoring-stage-store.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";

// ── WHICH INVOCATION'S VERDICT IS THE ONE THIS REVISION CERTIFIES ────────────────────────────────────
//
// `JudgmentClaim` already answers "who holds the right to write this (case, judge)": the stage arbitrates on
// (generation, attempt), the carrier write obeys, and a superseded invocation's judgment lands nowhere. That
// arbitration is authoritative and production-critical — and it is entirely EPHEMERAL. The stage rows are
// cleared at settle (they must be: one row per scorecard × pass × case × judge), and `ScoringRevision` — the
// record's own append-only statement of what was judged — carries the pass id, the sealed judge closure, and
// two digests, but nothing that names the CLAIM whose bytes each judgment came from.
//
// So a settled revision cannot answer the question the arbitration was built to decide. `scorePlaneDigest`
// says what the plane held; it is identical whichever invocation won, because the winner's bytes are the
// plane. When a case is later disputed — a judge that flapped across a replan round, a re-drive whose second
// generation disagreed with its first — the record says a verdict exists and cannot say which attempt of
// which round produced it, and the rows that could have said so were collected minutes after the settle by
// design.
//
// This is the same defect shape the receipt ledger already fixed one level down for EXECUTION (`latest row`
// is not `the committed attempt` — review 39/40) and it is unfixed one level up for JUDGMENT. A revision that
// names its inputs' digests but not their provenance certifies an answer whose author is unrecorded.
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

const judgeSpec: JudgeSpec = {
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
    return judgeSpec;
  },
  async versions() {
    return [judgeSpec.version];
  },
  async ownVersions() {
    return [judgeSpec.version];
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

const livePass: ScoringPass = {
  passId: "pass-1",
  epoch: 1,
  leaseUntil: "2026-08-15T00:05:00.000Z",
  heartbeatAt: "2026-08-15T00:00:00.000Z",
  targetRevision: 1,
  baseRevision: 0,
  judges: [],
  startedAt: "2026-08-15T00:00:00.000Z",
  status: "running",
};

const inherited: Score = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };

function caseResult(scores: Score[]): CaseResult {
  return {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores,
  };
}

// A REAL arbiter — the whole subject here is which claim won, so a stage that accepts everything would make
// the test certify nothing. Per (caseKey, judgeId), a later claim supersedes an earlier one and an earlier
// one arriving late is refused, exactly as `PgScoringStageStore` decides it.
function arbitratingStage(): { stage: ScoringStageStore; accepted: Array<{ key: string; claim?: JudgmentClaim }> } {
  const held = new Map<string, StagedJudgment>();
  const accepted: Array<{ key: string; claim?: JudgmentClaim }> = [];
  const stage: ScoringStageStore = {
    async stage(_scorecardId, _passId, entries) {
      const winners: StagedJudgment[] = [];
      for (const entry of entries) {
        const key = `${entry.caseKey}|${entry.judgeId}`;
        const prior = held.get(key);
        if (!claimSupersedes(prior?.claim, entry.claim ?? { generation: 0, attempt: 1 })) continue;
        held.set(key, entry);
        winners.push(entry);
        accepted.push({ key: entry.caseKey, ...(entry.claim ? { claim: entry.claim } : {}) });
      }
      return winners;
    },
    async staged() {
      return [...held.values()].map((row) => ({ ...row }));
    },
    async clear() {
      const n = held.size;
      held.clear();
      return n;
    },
  };
  return { stage, accepted };
}

// The judge itself: generation 1's invocation dies mid-call and leaves the unmeasured placeholder a replan
// round exists to replace; generation 2's invocation returns the verdict the record ends up certifying.
function flappingJudgeRunner(): JudgeRunner {
  let invocation = 0;
  return {
    async run() {
      invocation += 1;
      if (invocation === 1)
        return [
          {
            graderId: "a",
            metric: "judge:a",
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
            detail: "[grader-error] judge transport died",
          },
        ];
      return [{ graderId: "a", metric: "judge:a", value: 1, pass: true }];
    },
  };
}

function harness(): {
  svc: ScorecardScoreService;
  updates: Array<Partial<ScorecardRecord>>;
  accepted: Array<{ key: string; claim?: JudgmentClaim }>;
} {
  // Embed mode (no `runIds`) — the embedded scorecard IS the carrier, so the whole race is visible in one
  // record without a child-run store standing in the way of the thing under test.
  let record: ScorecardRecord = {
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results: [caseResult([inherited])] },
    scoringPass: livePass,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
  const updates: Array<Partial<ScorecardRecord>> = [];
  const { stage, accepted } = arbitratingStage();
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
    { store, datasets: unusedDatasets, scoringStage: stage },
    {
      newId: () => "pass-1",
      now: () => "2026-08-15T00:00:00.000Z",
      scoring: new ScoringService({ judges: judgeRegistry, judgeRunner: flappingJudgeRunner() }),
      getRecord: async () => record,
      pinJudges: async (_tenant, judgeRefs) => judgeRefs,
    },
  );
  return { svc, updates, accepted };
}

// The receipt shape wave 5 delivers, read off the settled revision. Declared locally (not imported) because
// it does not exist yet — that absence IS the counterexample, and the read is written against the store's own
// public record so the assertion survives the field arriving under `ScoringRevision`.
interface JudgmentReceiptEntry {
  caseKey: string;
  judgeId: string;
  claim: JudgmentClaim;
}

describe.skip("the settled ScoringRevision and the claim its judgments came from", () => {
  // [WAVE-5 COUNTEREXAMPLE #11] RED as of 02a3e15e: `AssertionError: expected undefined to deeply equal
  // [ { caseKey: 'c1#0', judgeId: 'a', claim: { generation: 2, attempt: 1 } } ]` — `ScoringRevision` has no
  // judgments vector at all, and the stage rows that hold the winning claim are cleared in the settle, so
  // after the pass nothing in the record names which invocation's verdict it certifies. Un-skip when wave 5
  // lands.
  it("pins which claim's evidence was adopted for each (case, judge) the pass judged", async () => {
    const { svc, updates, accepted } = harness();
    const judges = [{ id: "a", version: "1.0.0" }];

    // Given two invocations of "judge c1 with a" under one pass: generation 1 attempt 1 leaves an unmeasured
    // placeholder, and the replan round's generation 2 attempt 1 supersedes it with the verdict.
    await svc.scoreCase("sc-1", "c1#0", judges, undefined, "pass-1", { generation: 1, attempt: 1 });
    await svc.scoreCase("sc-1", "c1#0", judges, undefined, "pass-1", { generation: 2, attempt: 1 });
    // The arbitration itself works — this is the ground truth the record has to end up agreeing with.
    expect(accepted.map((a) => a.claim)).toEqual([
      { generation: 1, attempt: 1 },
      { generation: 2, attempt: 1 },
    ]);

    // When the pass settles
    await svc.finalizeScore("sc-1", judges, undefined, "pass-1");

    // Then the appended revision names the winning claim per (case, judge). Without it, the record certifies
    // a verdict whose author is unrecoverable the moment the stage is collected — which the settle does.
    const revision = updates
      .filter((u) => u.scoring !== undefined)
      .at(-1)
      ?.scoring?.at(-1);
    const judgments = (revision as Record<string, unknown> | undefined)?.judgments as
      | JudgmentReceiptEntry[]
      | undefined;
    expect(judgments).toEqual([{ caseKey: "c1#0", judgeId: "a", claim: { generation: 2, attempt: 1 } }]);
  });
});
