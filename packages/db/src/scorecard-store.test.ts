import type { Scorecard } from "@everdict/core";
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
  it("create/get 는 전체(scorecard 포함), list 는 무거운 scorecard 를 생략하고 summary·models 만", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec());
    await store.update("sc1", {
      status: "succeeded",
      summary: [{ metric: "steps", count: 1, mean: 3, passRate: 1 }],
      models: { observed: ["m"], primary: "m" },
      judgeModels: ["gpt-5.4-mini"],
      scorecard: SCORECARD,
    });
    const got = await store.get("sc1");
    expect(got?.status).toBe("succeeded");
    expect(got?.scorecard?.results).toHaveLength(1); // 상세엔 전체 결과
    const list = await store.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toHaveLength(1); // 목록엔 summary
    expect(list[0]?.models?.primary).toBe("m"); // model 축은 경량 → 목록에도 포함(리더보드용)
    expect(list[0]?.judgeModels).toEqual(["gpt-5.4-mini"]); // judge 축도 경량 → 목록 포함
    expect(list[0]?.scorecard).toBeUndefined(); // 목록엔 무거운 scorecard 없음
  });

  it("createdBy(실행자)·runtime(배치 런타임)은 경량 메타 — get 과 list 둘 다에 포함된다", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ createdBy: "user-alice", runtime: "self:mac" }));
    expect((await store.get("sc1"))?.createdBy).toBe("user-alice");
    expect((await store.get("sc1"))?.runtime).toBe("self:mac");
    expect((await store.list("acme"))[0]?.createdBy).toBe("user-alice");
    expect((await store.list("acme"))[0]?.runtime).toBe("self:mac");
  });

  it("트레이스 싱크 적재 결과(export)는 상세(get)에만 — 목록(list)에선 생략된다", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec());
    await store.update("sc1", {
      export: {
        sink: "mlflow",
        status: "succeeded",
        url: "http://mlflow.corp.io/#/experiments/7",
        exportedAt: "2026-06-19T00:00:02.000Z",
        cases: [{ caseId: "c1", externalId: "tr-abc", url: "http://mlflow.corp.io/#/experiments/7?tr=tr-abc" }],
      },
    });
    expect((await store.get("sc1"))?.export?.cases?.[0]?.externalId).toBe("tr-abc");
    expect((await store.list("acme"))[0]?.export).toBeUndefined(); // 목록엔 없음(steps 와 동급 상세)
  });

  it("list(filter) 로 dataset/harness/status 를 좁힌다(리더보드/트렌드가 전 워크스페이스 스캔 회피)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "a", dataset: { id: "d1", version: "1" }, status: "succeeded" }));
    await store.create(rec({ id: "b", dataset: { id: "d2", version: "1" }, status: "succeeded" }));
    await store.create(rec({ id: "c", dataset: { id: "d1", version: "1" }, status: "failed" }));
    expect((await store.list("acme", { dataset: "d1" })).map((r) => r.id).sort()).toEqual(["a", "c"]);
    expect((await store.list("acme", { dataset: "d1", status: "succeeded" })).map((r) => r.id)).toEqual(["a"]);
    expect(await store.list("acme")).toHaveLength(3); // 필터 없으면 전체(현행)
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
  models: { observed: ["m"], primary: "m" },
  judge_models: ["gpt-5.4-mini"],
  created_by: "user-alice",
  runtime: "docker",
  scorecard: SCORECARD,
  error: null,
  created_at: new Date("2026-06-19T00:00:00.000Z"),
  updated_at: new Date("2026-06-19T00:00:01.000Z"),
};

describe("PgScorecardStore", () => {
  it("create → 파라미터화 INSERT (jsonb 문자열화 + created_by 컬럼)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).create(rec({ createdBy: "user-alice" }));
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_scorecards/);
    expect(calls[0]?.params?.[0]).toBe("sc1");
    expect(calls[0]?.params?.[8]).toBeNull(); // models 없음(rec 기본)
    expect(calls[0]?.params?.[9]).toBeNull(); // judge_models 없음
    expect(calls[0]?.params?.[11]).toBe("user-alice"); // created_by(실행자)
    expect(calls[0]?.params?.[12]).toBeNull(); // scorecard 없음
  });

  it("get → row 를 ScorecardRecord 로 매핑(전체 scorecard + models + judgeModels + createdBy 포함)", async () => {
    const { client } = fakeClient(() => ({ rows: [ROW] }));
    const got = await new PgScorecardStore(client).get("sc1");
    expect(got?.dataset).toEqual({ id: "repo-smoke", version: "1.0.0" });
    expect(got?.scorecard?.suiteId).toBe("repo-smoke");
    expect(got?.models?.primary).toBe("m");
    expect(got?.judgeModels).toEqual(["gpt-5.4-mini"]);
    expect(got?.createdBy).toBe("user-alice");
    expect(got?.runtime).toBe("docker"); // 작업 큐 런타임 축
  });

  it("list → scorecard 컬럼 미선택(경량)하되 models·judge_models 는 SELECT + 테넌트 필터 + 정렬", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    const list = await new PgScorecardStore(client).list("acme");
    const selectClause = (calls[0]?.text ?? "").split("FROM")[0]; // FROM everdict_scorecards 의 테이블명은 제외
    expect(selectClause).not.toMatch(/ scorecard/); // 무거운 컬럼은 SELECT 안 함(judge_models 의 _models 오탐 방지 위해 공백 앵커)
    expect(selectClause).toMatch(/models/); // model 축은 경량 → 목록에 포함(리더보드용)
    expect(selectClause).toMatch(/judge_models/); // judge 축도 경량 → 목록 포함
    expect(selectClause).toMatch(/created_by/); // 실행자도 경량 → 목록 포함(표기/필터)
    expect(calls[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(list[0]?.scorecard).toBeUndefined();
    expect(list[0]?.summary).toHaveLength(1);
    expect(list[0]?.models?.primary).toBe("m");
    expect(list[0]?.judgeModels).toEqual(["gpt-5.4-mini"]);
    expect(list[0]?.createdBy).toBe("user-alice");
    expect(list[0]?.runtime).toBe("docker"); // 경량 → 목록 포함(런타임 레인)
  });

  it("export → update 는 sink_export 컬럼에 쓰고, get 은 export 필드로 되매핑한다(예약어 회피 컬럼명)", async () => {
    const EXPORT = {
      sink: "mlflow",
      status: "partial",
      exportedAt: "2026-06-19T00:00:02.000Z",
      cases: [
        { caseId: "c1", externalId: "tr-abc" },
        { caseId: "c2", error: "업스트림 500" },
      ],
    };
    // When: update 패치에 export — SQL 은 sink_export 컬럼으로.
    const upd = fakeClient(() => ({ rows: [{ ...ROW, sink_export: EXPORT }] }));
    const updated = await new PgScorecardStore(upd.client).update("sc1", {
      export: EXPORT as ScorecardRecord["export"],
    });
    expect(upd.calls[0]?.text).toMatch(/sink_export = \$1/);
    expect(upd.calls[0]?.params?.[0]).toBe(JSON.stringify(EXPORT));
    // Then: row 의 sink_export 가 record.export 로 돌아온다(get 경로 동일 매핑).
    expect(updated?.export?.status).toBe("partial");
    expect(updated?.export?.cases?.[1]?.error).toBe("업스트림 500");
  });

  it("list(filter) → SQL WHERE 에 dataset_id/status 절 + 파라미터화(전 스캔 회피)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { dataset: "d1", status: "succeeded" });
    expect(calls[0]?.text).toMatch(/dataset_id = \$2/);
    expect(calls[0]?.text).toMatch(/status = \$3/);
    expect(calls[0]?.params).toEqual(["acme", "d1", "succeeded"]);
  });
});
