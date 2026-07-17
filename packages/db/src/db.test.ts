import type { CaseResult, EvalCase } from "@everdict/contracts";
import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { PgCallbackStore } from "./activity/callback-store.js";
import type { SqlClient } from "./client.js";
import { migrate, preflight } from "./migrate.js";
import { PgRunStore } from "./results/pg-run-store.js";
import { InMemoryRunStore } from "./results/run-store.js";
import { InMemoryWorkspaceSettingsStore, PgWorkspaceSettingsStore } from "./workspace/workspace-settings.js";

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

  it("round-trips caseSpec (mig 0051, single-run durability): INSERT stringifies it, get maps it back", async () => {
    const caseSpec: EvalCase = {
      id: "c1",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
      placement: { target: "nomad-x" },
    };
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(client).create({
      id: "r2",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      caseId: "c1",
      status: "queued",
      caseSpec,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    expect(calls[0]?.params?.[12]).toBe(JSON.stringify(caseSpec)); // case_spec column, jsonb

    const { client: reader } = fakeClient(() => ({ rows: [{ ...ROW, case_spec: caseSpec }] }));
    const rec = await new PgRunStore(reader).get("r2");
    expect(rec?.caseSpec?.placement?.target).toBe("nomad-x"); // the effective (placement-injected) case survives
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

  it("list scope: default hides children ($3 false); includeChildren = all ($3 true); scorecardId = one batch ($2)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    const store = new PgRunStore(client);
    await store.list("acme");
    expect(calls[0]?.params).toEqual(["acme", null, false]);
    await store.list("acme", { includeChildren: true });
    expect(calls[1]?.params).toEqual(["acme", null, true]);
    await store.list("acme", { scorecardId: "sc1" });
    expect(calls[2]?.params).toEqual(["acme", "sc1", false]);
  });

  it("deleteByScorecard → parameterized DELETE on parent_scorecard_id; RETURNING rows = removed count", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ id: "a" }, { id: "b" }] }));
    await expect(new PgRunStore(client).deleteByScorecard("sc1")).resolves.toBe(2);
    expect(calls[0]?.text).toMatch(/DELETE FROM everdict_runs WHERE parent_scorecard_id = \$1/);
    expect(calls[0]?.params).toEqual(["sc1"]);
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

    // The activity console's all-executions view: standalone runs AND scorecard children together.
    const all = await store.list("acme", { includeChildren: true });
    expect(all.map((r) => r.id).sort()).toEqual(["run-child-a", "run-child-b", "run-child-c", "run-solo"]);

    // A child record round-trips parentScorecardId/trigger.
    const child = await store.get("run-child-a");
    expect(child?.parentScorecardId).toBe("sc1");
    expect(child?.trigger).toBe("scorecard");
  });

  it("deleteByScorecard removes ONLY that batch's children (scorecard hard-delete cascade) and reports the count", async () => {
    const store = new InMemoryRunStore();
    await store.create(mk("run-solo", {}));
    await store.create(mk("run-child-a", { parentScorecardId: "sc1", trigger: "scorecard" }));
    await store.create(mk("run-child-b", { parentScorecardId: "sc1", trigger: "scorecard" }));
    await store.create(mk("run-child-c", { parentScorecardId: "sc2", trigger: "scorecard" }));

    await expect(store.deleteByScorecard("sc1")).resolves.toBe(2);
    expect(await store.list("acme", { scorecardId: "sc1" })).toEqual([]);
    // Standalone runs and other batches' children survive.
    const all = await store.list("acme", { includeChildren: true });
    expect(all.map((r) => r.id).sort()).toEqual(["run-child-c", "run-solo"]);
    await expect(store.deleteByScorecard("sc1")).resolves.toBe(0); // idempotent — nothing left
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

describe("PgCallbackStore", () => {
  it("deliver inserts the body and sweeps dead rows; claim consumes atomically (SKIP LOCKED)", async () => {
    const { client, calls } = fakeClient((text) =>
      text.startsWith("UPDATE everdict_frontdoor_callbacks") ? { rows: [{ body: { status: "done" } }] } : { rows: [] },
    );
    const store = new PgCallbackStore(client);
    await store.deliver("run-1", { status: "done" });
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_frontdoor_callbacks \(run_id, body\)/);
    expect(calls[0]?.params).toEqual(["run-1", JSON.stringify({ status: "done" })]);
    expect(calls[1]?.text).toMatch(/DELETE FROM everdict_frontdoor_callbacks WHERE consumed/); // opportunistic sweep

    const claimed = await store.claim("run-1");
    expect(claimed).toEqual({ body: { status: "done" } });
    expect(calls[2]?.text).toMatch(/FOR UPDATE SKIP LOCKED/); // exactly-once consume across replicas
    expect(calls[2]?.text).toMatch(/SET consumed = true/);
  });

  it("claim returns undefined when nothing is pending", async () => {
    const { client } = fakeClient(() => ({ rows: [] }));
    expect(await new PgCallbackStore(client).claim("ghost")).toBeUndefined();
  });
});
