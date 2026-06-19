import type { Dispatcher } from "@assay/backends";
import { BadRequestError, type CaseResult, NotFoundError, type Scorecard } from "@assay/core";
import { InMemoryScorecardStore, type ScorecardRecord } from "@assay/db";
import { InMemoryDatasetRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";
import { ScorecardService } from "./scorecard-service.js";

const dispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("unused in diff tests");
  },
};

// 한 케이스에 tests-pass 점수 1건. pass 를 바꿔 회귀/개선을 만든다.
const caseResult = (pass: boolean): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
});

const record = (id: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  ...over,
});

const scorecard = (pass: boolean): Scorecard => ({ suiteId: "d", harness: "h@1", results: [caseResult(pass)] });

function svc(store: InMemoryScorecardStore): ScorecardService {
  return new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry() });
}

describe("ScorecardService.diff", () => {
  it("pass 전이를 회귀/개선으로 보고한다", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.regressions).toEqual([
      { caseId: "c1", metric: "tests-pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" },
    ]);
    expect(diff.improvements).toEqual([]);
    expect(diff.metrics).toContainEqual({
      metric: "tests-pass",
      baselineMean: 1,
      candidateMean: 0,
      delta: -1,
    });
  });

  it("없는/타 워크스페이스 스코어카드 → NotFoundError(404)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("other", { tenant: "beta", scorecard: scorecard(true) }));
    await expect(svc(store).diff("acme", "base", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).diff("acme", "base", "other")).rejects.toBeInstanceOf(NotFoundError); // 타 워크스페이스
  });

  it("미완료(scorecard 없음) → BadRequestError(400)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("queued", { status: "queued" }));
    await expect(svc(store).diff("acme", "base", "queued")).rejects.toBeInstanceOf(BadRequestError);
  });
});
