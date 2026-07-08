import type { CaseResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import { migrate, preflight } from "./migrate.js";
import { PgRunStore } from "./pg-run-store.js";
import { InMemoryRunStore, type RunRecord } from "./run-store.js";
import { InMemoryWorkspaceSettingsStore, PgWorkspaceSettingsStore } from "./workspace-settings.js";

// A fake SqlClient that records queries and returns canned rows.
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
  it("create → parameterized INSERT (jsonb is stringified)", async () => {
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
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_runs/);
    expect(calls[0]?.params?.[0]).toBe("r1");
    expect(calls[0]?.params?.[6]).toBeNull(); // no result
  });

  it("get → maps the row to a RunRecord (Date→ISO, jsonb→object) + derives usage", async () => {
    const { client } = fakeClient(() => ({ rows: [ROW] }));
    const rec = await new PgRunStore(client).get("r1");
    expect(rec?.harness).toEqual({ id: "scripted", version: "0" });
    expect(rec?.caseId).toBe("c1");
    expect(rec?.createdAt).toBe("2026-06-18T00:00:00.000Z");
    expect(rec?.result?.harness).toBe("scripted@0");
    // usage is derived from result.trace (not a column).
    expect(rec?.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.02, calls: 1 });
  });

  it("update → dynamic SET of only the patched fields + RETURNING", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ ...ROW, status: "succeeded" }] }));
    const rec = await new PgRunStore(client).update("r1", { status: "succeeded", result: RESULT, updatedAt: "x" });
    expect(calls[0]?.text).toMatch(
      /UPDATE everdict_runs SET status = \$1, result = \$2, updated_at = \$3 WHERE id = \$4/,
    );
    expect(rec?.status).toBe("succeeded");
  });

  it("update persists a runtime patch (spillover provenance is not silently dropped)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ ...ROW, runtime: "kind-local" }] }));
    const rec = await new PgRunStore(client).update("r1", { runtime: "kind-local", updatedAt: "x" });
    expect(calls[0]?.text).toMatch(/UPDATE everdict_runs SET runtime = \$1, updated_at = \$2 WHERE id = \$3/);
    expect(rec?.runtime).toBe("kind-local");
  });

  it("list → tenant filter + created_at DESC sort", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    await new PgRunStore(client).list("acme");
    expect(calls[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(calls[0]?.params?.[0]).toBe("acme");
  });
});

describe("WorkspaceSettingsStore", () => {
  it("InMemory: get(unset)→undefined; set is a partial-merge upsert", async () => {
    const s = new InMemoryWorkspaceSettingsStore();
    expect(await s.get("acme")).toBeUndefined();
    expect(await s.set("acme", { meterUsage: true })).toEqual({ meterUsage: true });
    expect(await s.set("acme", {})).toEqual({ meterUsage: true }); // an empty patch preserves the existing value (merge)
    expect((await s.get("acme"))?.meterUsage).toBe(true);
    expect(await s.get("beta")).toBeUndefined(); // workspace isolation
  });

  it("Pg: set is a jsonb-merge (||) upsert + RETURNING; get parses settings", async () => {
    const { client, calls } = fakeClient((text) =>
      text.startsWith("INSERT")
        ? { rows: [{ settings: { meterUsage: true } }] }
        : { rows: [{ settings: { meterUsage: false } }] },
    );
    const store = new PgWorkspaceSettingsStore(client);
    expect(await store.set("acme", { meterUsage: true })).toEqual({ meterUsage: true });
    expect(calls[0]?.text).toMatch(/settings \|\| \$2::jsonb/); // atomic merge
    expect(await store.get("acme")).toEqual({ meterUsage: false });
  });
});

describe("InMemoryRunStore — usage derivation", () => {
  const base: RunRecord = {
    id: "r1",
    tenant: "acme",
    harness: { id: "s", version: "0" },
    caseId: "c1",
    status: "queued",
    createdAt: "t",
    updatedAt: "t",
  };

  it("no result → no usage; with a result, derive it from the trace (get/list/update)", async () => {
    const store = new InMemoryRunStore();
    await store.create(base);
    expect((await store.get("r1"))?.usage).toBeUndefined(); // queued, no result

    const updated = await store.update("r1", { status: "succeeded", result: RESULT });
    expect(updated?.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.02, calls: 1 });
    expect((await store.get("r1"))?.usage?.totalTokens).toBe(2);
    expect((await store.list("acme"))[0]?.usage?.usd).toBeCloseTo(0.02);
  });
});

describe("InMemoryRunStore — scorecard child-run filter", () => {
  const mk = (id: string, extra: Partial<RunRecord>): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "s", version: "0" },
    caseId: "c1",
    status: "succeeded",
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  });

  it("default list is standalone only (children hidden); the scorecardId option is that batch's children only", async () => {
    const store = new InMemoryRunStore();
    await store.create(mk("run-solo", {}));
    await store.create(mk("run-child-a", { parentScorecardId: "sc1", trigger: "scorecard" }));
    await store.create(mk("run-child-b", { parentScorecardId: "sc1", trigger: "scorecard" }));
    await store.create(mk("run-child-c", { parentScorecardId: "sc2", trigger: "scorecard" }));

    // The activity list (default) hides the 3 children and shows only standalone (prevents flooding).
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["run-solo"]);

    // The case drill-down in scorecard detail: that batch's children only.
    const sc1 = await store.list("acme", { scorecardId: "sc1" });
    expect(sc1.map((r) => r.id).sort()).toEqual(["run-child-a", "run-child-b"]);

    // A child record round-trips parentScorecardId/trigger.
    const child = await store.get("run-child-a");
    expect(child?.parentScorecardId).toBe("sc1");
    expect(child?.trigger).toBe("scorecard");
  });
});

describe("migrate", () => {
  it("applies only the un-applied ones and records them in tracking, skipping already-applied ones", async () => {
    const appliedNames = new Set<string>();
    const { client, calls } = fakeClient((text, params) => {
      if (text.includes("SELECT name FROM")) {
        const name = String(params?.[0]);
        return { rows: appliedNames.has(name) ? [{ name }] : [] };
      }
      if (text.startsWith("INSERT INTO everdict_schema_migrations")) {
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
    expect(second.applied).toEqual([]); // re-running is idempotent
    expect(calls.some((c) => c.text.includes("CREATE TABLE IF NOT EXISTS everdict_schema_migrations"))).toBe(true);
  });

  it("preflight: un-applied OK_TO_APPLY / applied ALREADY_APPLIED", async () => {
    const { client } = fakeClient((text) => ({ rows: text.includes("SELECT name FROM") ? [] : [] }));
    expect(await preflight(client, "0001_create_runs.sql")).toBe("OK_TO_APPLY");
    const applied = fakeClient((text) => ({ rows: text.includes("SELECT name FROM") ? [{ name: "x" }] : [] }));
    expect(await preflight(applied.client, "0001_create_runs.sql")).toBe("ALREADY_APPLIED");
  });
});
