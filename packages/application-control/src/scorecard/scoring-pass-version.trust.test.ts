import { InMemoryCaseReceiptStore } from "@everdict/application-control";
import type { CaseResult, JudgeSpec, RunRecord, Score, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";

// The judge port answers an INVOCATION now — the verdict plus whether the judge's own execution could be
// sealed as evidence (arch-review 58 follow-through). These fakes are about the verdict, so they answer
// `not_applicable`: none of them has a trajectory store to seal into, which is exactly that value's meaning.
// A fake that still answered a bare array would be LESS capable than the port it stands in for.
const judgeInvocation = (scores: unknown) => ({ scores, evidence: "not_applicable" }) as never;

// Trust suite (docs/trust-certification.md) — TRUST-36.
//
// AN OLD VERSION'S SCORE IS NOT THE NEW VERSION'S COMPLETION. The Temporal scoring pass's worklist
// predicate is id-only — the score plane cannot represent a judge VERSION — so with quality@1's measured
// verdicts in place, a re-score requesting quality@2 planned an EMPTY worklist and went straight to
// finalize, which refreshes the sealed closure and judgeModels to the NEW version: the record advertised
// quality@2 over judgments quality@2 never made. The production pass now STRIPS FIRST (prepareScore, once
// per pass, persisted through the child-run write-back), so "already judged" means "judged in THIS pass" —
// certified here over the exact prepare → plan → judge sequence the workflow drives.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

// The pass these activities act as — ownership is presented on every one of them (see `hydrated`).
const PASS = "pass-36";

const v1Verdict: Score = { graderId: "quality", metric: "judge:quality", value: 0, pass: false, detail: "v1 said no" };

const result = (scores: Score[]): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores,
});

describeTrust("TRUST-36 — a re-score at a NEW judge version actually re-judges", () => {
  it("prepare strips the old version's verdicts, the plan lists the case, and the plane ends with the new version's judgment", async () => {
    const child: RunRecord = {
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: result([v1Verdict]),
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    const runStore = {
      async create() {
        throw new Error("unused");
      },
      async update(_id: string, patch: Partial<RunRecord>) {
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
    } satisfies RunStore;
    const quality2: JudgeSpec = {
      kind: "model",
      id: "quality",
      version: "2.0.0",
      provider: "anthropic",
      model: "m2",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    };
    const judges = {
      async register() {
        throw new Error("unused");
      },
      async has() {
        return true;
      },
      async get() {
        return quality2;
      },
      async versions() {
        return ["2.0.0"];
      },
      async ownVersions() {
        return ["2.0.0"];
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
      // Ownership is not a question these cores ask. Throwing rather than answering `undefined` keeps the
      // double from silently supplying the permissive arm of a gate it does not model (arch-review 119).
      async teamOfVersion(): Promise<string | undefined> {
        throw new Error("unused");
      },
    } satisfies JudgeRegistry;
    // The v2 judge's runner — its verdict is DISTINGUISHABLE from v1's, so "re-judged" is observable.
    const judgeRunner: JudgeRunner = {
      async run() {
        return judgeInvocation([
          { graderId: "quality", metric: "judge:quality", value: 1, pass: true, detail: "v2 says yes" },
        ]);
      },
    };
    // The record carries the LIVE PASS its activities run under. Every scoring activity now presents the
    // passId its claim minted and is refused without one (arch-review 9 P0) — an anonymous writer cannot be
    // fenced, so it may not act. A fixture with no marker was certifying a sequence production no longer
    // permits; the invariant under test is unchanged, the caller's obligation is not.
    const hydrated = (): ScorecardRecord => ({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      scorecard: { suiteId: "d", harness: "h@1", results: child.result ? [child.result] : [] },
      runIds: ["child-c1"],
      scoringPass: {
        passId: PASS,
        epoch: 1,
        leaseUntil: "2026-08-09T00:05:00.000Z",
        heartbeatAt: "2026-08-09T00:00:00.000Z",
        targetRevision: 1,
        baseRevision: 0,
        judges: [],
        startedAt: "2026-08-09T00:00:00.000Z",
        status: "running",
      },
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    });
    const store = {
      async create() {
        throw new Error("unused");
      },
      async update() {
        return hydrated();
      },
      async get() {
        return hydrated();
      },
      async list() {
        return [];
      },
      async delete() {
        return false;
      },
    } satisfies ScorecardStore;
    const deps: ScorecardServiceDeps = {
      dispatcher: {
        async dispatch() {
          throw new Error("unused");
        },
      },
      store,
      datasets: {
        // Ownership is not a question these cores ask. Throwing rather than answering `undefined` keeps the
        // double from silently supplying the permissive arm of a gate it does not model (arch-review 119).
        async teamOfVersion(): Promise<string | undefined> {
          throw new Error("unused");
        },
        async register() {
          throw new Error("unused");
        },
        async has() {
          return false;
        },
        async get() {
          throw new Error("shell fallback");
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
      },
      runStore,
      caseReceipts: new InMemoryCaseReceiptStore(),
    };
    const svc = new ScorecardScoreService(deps, {
      newId: () => "id-1",
      now: () => "2026-08-09T00:00:00.000Z",
      scoring: new ScoringService({ judges, judgeRunner }),
      getRecord: async () => hydrated(),
      pinJudges: async (_tenant, refs) => refs,
    });
    const v2 = [{ id: "quality", version: "2.0.0" }];

    // The named trap, pinned first: WITHOUT the strip, the id-only predicate reads v1's verdict as done.
    expect((await svc.planScore("sc-1", v2, PASS)).keys).toEqual([]);

    // The production sequence: prepare (strip, persisted) → plan (full worklist) → judge (v2's verdict lands).
    expect(await svc.prepareScore("sc-1", v2, PASS)).toEqual({ stripped: 1 });
    expect((await svc.planScore("sc-1", v2, PASS)).keys).toEqual(["c1#0"]);
    expect(await svc.scoreCase("sc-1", "c1#0", v2, undefined, PASS)).toEqual({ scored: true });
    const verdicts = (child.result?.scores ?? []).filter((s) => s.metric === "judge:quality");
    expect(verdicts).toHaveLength(1); // replaced, never accreted
    expect(verdicts[0]).toMatchObject({ value: 1, pass: true, detail: "v2 says yes" }); // the NEW version's judgment
    // And the pass is now idempotently DONE — a resumed workflow re-plans to an empty remainder.
    expect((await svc.planScore("sc-1", v2, PASS)).keys).toEqual([]);
  });
});
