import type {
  CaseResult,
  Dataset,
  JudgeSpec,
  RunRecord,
  Score,
  ScorecardRecord,
  ScoringPass,
} from "@everdict/contracts";
import { judgmentReceiptSetDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { type JudgmentClaim, type ScoringStageStore, claimSupersedes } from "../ports/scoring-stage-store.js";
import type { StagedJudgment } from "../ports/scoring-stage-store.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";

// The judge port answers an INVOCATION now — the verdict plus whether the judge's own execution could be
// sealed as evidence (arch-review 58 follow-through). These fakes are about the verdict, so they answer
// `not_applicable`: none of them has a trajectory store to seal into, which is exactly that value's meaning.
// A fake that still answered a bare array would be LESS capable than the port it stands in for.
const judgeInvocation = (scores: unknown) => ({ scores, evidence: "not_applicable" }) as never;

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
        return judgeInvocation([
          {
            graderId: "a",
            metric: "judge:a",
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
            detail: "[grader-error] judge transport died",
          },
        ]);
      return judgeInvocation([{ graderId: "a", metric: "judge:a", value: 1, pass: true }]);
    },
  };
}

function harness(opts: { refuseSettle?: boolean } = {}): {
  svc: ScorecardScoreService;
  updates: Array<Partial<ScorecardRecord>>;
  accepted: Array<{ key: string; claim?: JudgmentClaim }>;
  stage: ScoringStageStore;
} {
  // A runIds-backed group with ONE child carrier — the only shape that reaches this code path in production
  // (`score()`: "an embed group has no per-case store, so it takes the in-process pass", and the in-process
  // pass holds no claims because it has no per-case retry seam). Judging an embed group case-by-case would
  // stage judgments the record never carries, and a receipt minted from that would certify a verdict nobody
  // adopted — the exact thing this vector exists to make impossible.
  const child: RunRecord = {
    id: "child-c1",
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    status: "succeeded",
    result: caseResult([inherited]),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
  const runStore: RunStore = {
    async create() {
      throw new Error("unused");
    },
    async update(_id, patch) {
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
  let patched: Partial<ScorecardRecord> = {};
  // The record as a reader gets it: the persisted row with the plane HYDRATED from the child carrier, which
  // is what makes the write-back visible to the settle.
  const hydrated = (): ScorecardRecord =>
    ({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      runIds: [child.id],
      scoringPass: livePass,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      ...patched,
      scorecard: { suiteId: "d", harness: "h@1", results: child.result ? [child.result] : [] },
    }) as ScorecardRecord;
  const updates: Array<Partial<ScorecardRecord>> = [];
  const { stage, accepted } = arbitratingStage();
  const store: ScorecardStore = {
    ...unusedStore,
    async get() {
      return hydrated();
    },
    async update(_id, patch, _events, guard) {
      // The GUARDED settle — the one write that carries `expectScoringCount`. `refuseSettle` makes it miss,
      // which is what a concurrent pass settling first looks like from in here.
      if (opts.refuseSettle === true && guard?.expectScoringCount !== undefined) return undefined;
      updates.push(patch);
      patched = { ...patched, ...patch };
      return hydrated();
    },
  };
  const svc = new ScorecardScoreService(
    { store, datasets: unusedDatasets, scoringStage: stage, runStore },
    {
      newId: () => "pass-1",
      now: () => "2026-08-15T00:00:00.000Z",
      scoring: new ScoringService({ judges: judgeRegistry, judgeRunner: flappingJudgeRunner() }),
      getRecord: async () => hydrated(),
      pinJudges: async (_tenant, judgeRefs) => judgeRefs,
    },
  );
  return { svc, updates, accepted, stage };
}

// The settled revision, as a reader finds it: the last appended entry of the last scoring write.
function settledRevision(updates: Array<Partial<ScorecardRecord>>) {
  return updates
    .filter((u) => u.scoring !== undefined)
    .at(-1)
    ?.scoring?.at(-1);
}

describe("the settled ScoringRevision and the claim its judgments came from", () => {
  // [WAVE-5 COUNTEREXAMPLE #11] Was RED as of 02a3e15e: `ScoringRevision` had no judgments vector at all, and
  // the stage rows that hold the winning claim are cleared in the settle, so after the pass nothing in the
  // record named which invocation's verdict it certifies.
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
    const revision = settledRevision(updates);
    expect(revision?.judgments).toEqual([
      {
        ref: {
          scoringPassId: "pass-1",
          // The plane's own (case, trial) identity — this fixture's result has NO trial axis, so the receipt
          // must not invent trial 0 out of the `c1#0` map key.
          case: { caseId: "c1" },
          judgeId: "a",
          claim: { generation: 2, attempt: 1 },
        },
        scoreDigest: expect.any(String),
        // …and it points at generation 2's OWN evidence plane, which is the whole reason the claim is worth
        // recording: generation 1 sealed `judge:a#pass-1.1.1` and lost, and both planes outlive the pass.
        evidenceEmitter: "judge:a#pass-1.2.1",
      },
    ]);
    // The set digest describes the vector it is stored beside — not a set computed some other way.
    expect(revision?.judgmentReceiptSetDigest).toBe(judgmentReceiptSetDigest(revision?.judgments ?? []));
  });

  // The vector's whole value is that it outlives the stage — so the write that publishes it must commit
  // BEFORE the rows that produced it are collected. A settle that LOSES its guard publishes nothing, and
  // therefore must collect nothing: the winning pass's own settle still has to find the claims there.
  it("keeps a pass's stage rows when its guarded settle is refused, so the vector is never cleared unpublished", async () => {
    const { svc, updates, stage } = harness({ refuseSettle: true });
    const judges = [{ id: "a", version: "1.0.0" }];
    await svc.scoreCase("sc-1", "c1#0", judges, undefined, "pass-1", { generation: 1, attempt: 1 });

    // When the settle loses the race it declares the refusal instead of appending a revision
    await expect(svc.finalizeScore("sc-1", judges, undefined, "pass-1")).rejects.toThrow(
      /another scoring pass settled this group first/,
    );

    // Then nothing was published…
    expect(settledRevision(updates)).toBeUndefined();
    // …and nothing was collected: the claims are still readable, which is exactly what a clear that ran
    // ahead of the commit would have destroyed.
    expect(await stage.staged("sc-1", "pass-1")).toEqual([
      expect.objectContaining({ caseKey: "c1#0", judgeId: "a", claim: { generation: 1, attempt: 1 } }),
    ]);
  });
});
