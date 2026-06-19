import type { CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import { migrate, preflight } from "./migrate.js";
import { PgRunStore } from "./pg-run-store.js";
import { InMemoryRunStore, type RunRecord } from "./run-store.js";

// 쿼리를 기록하고 canned row 를 돌려주는 가짜 SqlClient.
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

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.02 } }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

const ROW = {
  id: "r1",
  tenant: "acme",
  harness_id: "scripted",
  harness_version: "0",
  case_id: "c1",
  status: "succeeded",
  result: RESULT,
  error: null,
  created_at: new Date("2026-06-18T00:00:00.000Z"),
  updated_at: new Date("2026-06-18T00:00:01.000Z"),
};

describe("PgRunStore", () => {
  it("create → 파라미터화 INSERT (jsonb 는 문자열화)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgRunStore(client);
    const rec: RunRecord = {
      id: "r1",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      caseId: "c1",
      status: "queued",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    await store.create(rec);
    expect(calls[0]?.text).toMatch(/INSERT INTO assay_runs/);
    expect(calls[0]?.params?.[0]).toBe("r1");
    expect(calls[0]?.params?.[6]).toBeNull(); // result 없음
  });

  it("get → row 를 RunRecord 로 매핑(Date→ISO, jsonb→object) + usage 파생", async () => {
    const { client } = fakeClient(() => ({ rows: [ROW] }));
    const rec = await new PgRunStore(client).get("r1");
    expect(rec?.harness).toEqual({ id: "scripted", version: "0" });
    expect(rec?.caseId).toBe("c1");
    expect(rec?.createdAt).toBe("2026-06-18T00:00:00.000Z");
    expect(rec?.result?.harness).toBe("scripted@0");
    // usage 는 result.trace 에서 파생(컬럼 아님).
    expect(rec?.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.02, calls: 1 });
  });

  it("update → 패치 필드만 동적 SET + RETURNING", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ ...ROW, status: "succeeded" }] }));
    const rec = await new PgRunStore(client).update("r1", { status: "succeeded", result: RESULT, updatedAt: "x" });
    expect(calls[0]?.text).toMatch(/UPDATE assay_runs SET status = \$1, result = \$2, updated_at = \$3 WHERE id = \$4/);
    expect(rec?.status).toBe("succeeded");
  });

  it("list → 테넌트 필터 + created_at DESC 정렬", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    await new PgRunStore(client).list("acme");
    expect(calls[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(calls[0]?.params?.[0]).toBe("acme");
  });
});

describe("InMemoryRunStore — usage 파생", () => {
  const base: RunRecord = {
    id: "r1",
    tenant: "acme",
    harness: { id: "s", version: "0" },
    caseId: "c1",
    status: "queued",
    createdAt: "t",
    updatedAt: "t",
  };

  it("result 없으면 usage 없음; result 있으면 trace 에서 파생(get/list/update)", async () => {
    const store = new InMemoryRunStore();
    await store.create(base);
    expect((await store.get("r1"))?.usage).toBeUndefined(); // queued, result 없음

    const updated = await store.update("r1", { status: "succeeded", result: RESULT });
    expect(updated?.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.02, calls: 1 });
    expect((await store.get("r1"))?.usage?.totalTokens).toBe(2);
    expect((await store.list("acme"))[0]?.usage?.usd).toBeCloseTo(0.02);
  });
});

describe("migrate", () => {
  it("미적용만 적용하고 트래킹에 기록, 이미 적용된 건 건너뛴다", async () => {
    const appliedNames = new Set<string>();
    const { client, calls } = fakeClient((text, params) => {
      if (text.includes("SELECT name FROM")) {
        const name = String(params?.[0]);
        return { rows: appliedNames.has(name) ? [{ name }] : [] };
      }
      if (text.startsWith("INSERT INTO assay_schema_migrations")) {
        appliedNames.add(String(params?.[0]));
      }
      return { rows: [] };
    });
    const migrations = [
      { name: "0001_a.sql", sql: "CREATE TABLE a();" },
      { name: "0002_b.sql", sql: "CREATE TABLE b();" },
    ];
    const first = await migrate(client, { migrations });
    expect(first.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    const second = await migrate(client, { migrations });
    expect(second.applied).toEqual([]); // 재실행은 멱등
    expect(calls.some((c) => c.text.includes("CREATE TABLE IF NOT EXISTS assay_schema_migrations"))).toBe(true);
  });

  it("preflight: 미적용 OK_TO_APPLY / 적용됨 ALREADY_APPLIED", async () => {
    const { client } = fakeClient((text) => ({ rows: text.includes("SELECT name FROM") ? [] : [] }));
    expect(await preflight(client, "0001_create_runs.sql")).toBe("OK_TO_APPLY");
    const applied = fakeClient((text) => ({ rows: text.includes("SELECT name FROM") ? [{ name: "x" }] : [] }));
    expect(await preflight(applied.client, "0001_create_runs.sql")).toBe("ALREADY_APPLIED");
  });
});
