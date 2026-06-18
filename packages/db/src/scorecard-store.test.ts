import type { Scorecard } from "@assay/core";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore, type ScorecardRecord } from "./scorecard-store.js";

const SCORECARD: Scorecard = {
  suiteId: "repo-smoke",
  harness: "scripted@0",
  results: [
    {
      caseId: "c1",
      harness: "scripted@0",
      trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.02 } }],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [{ graderId: "steps", metric: "steps", value: 3, pass: true }],
    },
  ],
};

const rec = (over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id: "sc1",
  tenant: "acme",
  dataset: { id: "repo-smoke", version: "1.0.0" },
  harness: { id: "scripted", version: "0" },
  status: "queued",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  ...over,
});

describe("InMemoryScorecardStore", () => {
  it("create/get 는 전체(scorecard 포함), list 는 무거운 scorecard 를 생략하고 summary 만", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec());
    await store.update("sc1", {
      status: "succeeded",
      summary: [{ metric: "steps", count: 1, mean: 3, passRate: 1 }],
      scorecard: SCORECARD,
    });
    const got = await store.get("sc1");
    expect(got?.status).toBe("succeeded");
    expect(got?.scorecard?.results).toHaveLength(1); // 상세엔 전체 결과
    const list = await store.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toHaveLength(1); // 목록엔 summary
    expect(list[0]?.scorecard).toBeUndefined(); // 목록엔 무거운 scorecard 없음
  });
});

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

const ROW = {
  id: "sc1",
  tenant: "acme",
  dataset_id: "repo-smoke",
  dataset_version: "1.0.0",
  harness_id: "scripted",
  harness_version: "0",
  status: "succeeded",
  summary: [{ metric: "steps", count: 1, mean: 3, passRate: 1 }],
  scorecard: SCORECARD,
  error: null,
  created_at: new Date("2026-06-19T00:00:00.000Z"),
  updated_at: new Date("2026-06-19T00:00:01.000Z"),
};

describe("PgScorecardStore", () => {
  it("create → 파라미터화 INSERT (jsonb 문자열화)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).create(rec());
    expect(calls[0]?.text).toMatch(/INSERT INTO assay_scorecards/);
    expect(calls[0]?.params?.[0]).toBe("sc1");
    expect(calls[0]?.params?.[8]).toBeNull(); // scorecard 없음
  });

  it("get → row 를 ScorecardRecord 로 매핑(전체 scorecard 포함)", async () => {
    const { client } = fakeClient(() => ({ rows: [ROW] }));
    const got = await new PgScorecardStore(client).get("sc1");
    expect(got?.dataset).toEqual({ id: "repo-smoke", version: "1.0.0" });
    expect(got?.scorecard?.suiteId).toBe("repo-smoke");
  });

  it("list → scorecard 컬럼 미선택(경량) + 테넌트 필터 + 정렬", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    const list = await new PgScorecardStore(client).list("acme");
    const selectClause = (calls[0]?.text ?? "").split("FROM")[0]; // FROM assay_scorecards 의 테이블명은 제외
    expect(selectClause).not.toMatch(/scorecard/); // 무거운 컬럼은 SELECT 안 함
    expect(calls[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(list[0]?.scorecard).toBeUndefined();
    expect(list[0]?.summary).toHaveLength(1);
  });
});
