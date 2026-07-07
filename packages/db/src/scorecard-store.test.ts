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
  it("create/get returns the full record (incl. scorecard); list omits the heavy scorecard and keeps only summary·models", async () => {
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
    expect(got?.scorecard?.results).toHaveLength(1); // detail has the full results
    const list = await store.list("acme");
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toHaveLength(1); // list has summary
    expect(list[0]?.models?.primary).toBe("m"); // the model axis is lightweight → included in list too (for leaderboard)
    expect(list[0]?.judgeModels).toEqual(["gpt-5.4-mini"]); // the judge axis is lightweight too → included in list
    expect(list[0]?.scorecard).toBeUndefined(); // list has no heavy scorecard
  });

  it("createdBy (runner)·runtime (placement runtime) are lightweight meta — included in both get and list", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ createdBy: "user-alice", runtime: "self:mac" }));
    expect((await store.get("sc1"))?.createdBy).toBe("user-alice");
    expect((await store.get("sc1"))?.runtime).toBe("self:mac");
    expect((await store.list("acme"))[0]?.createdBy).toBe("user-alice");
    expect((await store.list("acme"))[0]?.runtime).toBe("self:mac");
  });

  it("the trace-sink export result (export) is detail-only (get) — omitted from list", async () => {
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
    expect((await store.list("acme"))[0]?.export).toBeUndefined(); // absent from list (detail, on par with steps)
  });

  it("list(filter) narrows dataset/harness/status (so leaderboard/trend avoid a full-workspace scan)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "a", dataset: { id: "d1", version: "1" }, status: "succeeded" }));
    await store.create(rec({ id: "b", dataset: { id: "d2", version: "1" }, status: "succeeded" }));
    await store.create(rec({ id: "c", dataset: { id: "d1", version: "1" }, status: "failed" }));
    expect((await store.list("acme", { dataset: "d1" })).map((r) => r.id).sort()).toEqual(["a", "c"]);
    expect((await store.list("acme", { dataset: "d1", status: "succeeded" })).map((r) => r.id)).toEqual(["a"]);
    expect(await store.list("acme")).toHaveLength(3); // no filter → everything (current behavior)
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
  it("create → parameterized INSERT (jsonb stringify + created_by column)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).create(rec({ createdBy: "user-alice" }));
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_scorecards/);
    expect(calls[0]?.params?.[0]).toBe("sc1");
    expect(calls[0]?.params?.[8]).toBeNull(); // no models (rec default)
    expect(calls[0]?.params?.[9]).toBeNull(); // no judge_models
    expect(calls[0]?.params?.[11]).toBe("user-alice"); // created_by (runner)
    expect(calls[0]?.params?.[12]).toBeNull(); // no scorecard
  });

  it("get → maps the row to a ScorecardRecord (incl. full scorecard + models + judgeModels + createdBy)", async () => {
    const { client } = fakeClient(() => ({ rows: [ROW] }));
    const got = await new PgScorecardStore(client).get("sc1");
    expect(got?.dataset).toEqual({ id: "repo-smoke", version: "1.0.0" });
    expect(got?.scorecard?.suiteId).toBe("repo-smoke");
    expect(got?.models?.primary).toBe("m");
    expect(got?.judgeModels).toEqual(["gpt-5.4-mini"]);
    expect(got?.createdBy).toBe("user-alice");
    expect(got?.runtime).toBe("docker"); // work-queue runtime axis
  });

  it("list → doesn't select the scorecard column (lightweight) but does SELECT models·judge_models + tenant filter + sort", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    const list = await new PgScorecardStore(client).list("acme");
    const selectClause = (calls[0]?.text ?? "").split("FROM")[0]; // exclude the FROM everdict_scorecards table name
    expect(selectClause).not.toMatch(/ scorecard/); // don't SELECT the heavy column (leading space anchor to avoid a false hit on judge_models' _models)
    expect(selectClause).toMatch(/models/); // the model axis is lightweight → included in list (for leaderboard)
    expect(selectClause).toMatch(/judge_models/); // the judge axis is lightweight too → included in list
    expect(selectClause).toMatch(/created_by/); // the runner is lightweight too → included in list (display/filter)
    expect(calls[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(list[0]?.scorecard).toBeUndefined();
    expect(list[0]?.summary).toHaveLength(1);
    expect(list[0]?.models?.primary).toBe("m");
    expect(list[0]?.judgeModels).toEqual(["gpt-5.4-mini"]);
    expect(list[0]?.createdBy).toBe("user-alice");
    expect(list[0]?.runtime).toBe("docker"); // lightweight → included in list (runtime lane)
  });

  it("export → update writes to the sink_export column, and get maps it back to the export field (reserved-word-avoiding column name)", async () => {
    const EXPORT = {
      sink: "mlflow",
      status: "partial",
      exportedAt: "2026-06-19T00:00:02.000Z",
      cases: [
        { caseId: "c1", externalId: "tr-abc" },
        { caseId: "c2", error: "upstream 500" },
      ],
    };
    // When: export in the update patch — SQL goes to the sink_export column.
    const upd = fakeClient(() => ({ rows: [{ ...ROW, sink_export: EXPORT }] }));
    const updated = await new PgScorecardStore(upd.client).update("sc1", {
      export: EXPORT as ScorecardRecord["export"],
    });
    expect(upd.calls[0]?.text).toMatch(/sink_export = \$1/);
    expect(upd.calls[0]?.params?.[0]).toBe(JSON.stringify(EXPORT));
    // Then: the row's sink_export comes back as record.export (get path, same mapping).
    expect(updated?.export?.status).toBe("partial");
    expect(updated?.export?.cases?.[1]?.error).toBe("upstream 500");
  });

  it("list(filter) → dataset_id/status clauses in the SQL WHERE + parameterization (avoids a full scan)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { dataset: "d1", status: "succeeded" });
    expect(calls[0]?.text).toMatch(/dataset_id = \$2/);
    expect(calls[0]?.text).toMatch(/status = \$3/);
    expect(calls[0]?.params).toEqual(["acme", "d1", "succeeded"]);
  });
});
