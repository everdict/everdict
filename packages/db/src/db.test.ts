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

  it("create persists the owning team, and get maps it back (mig 0106 — the column existed, nothing wrote it)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(client).create({
      id: "r4",
      tenant: "acme",
      teamId: "team-eng",
      harness: { id: "scripted", version: "0" },
      caseId: "c1",
      status: "queued",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(calls[0]?.text).toMatch(/created_by, team_id/);
    expect(calls[0]?.params?.[11]).toBe("team-eng");

    const { client: reader } = fakeClient(() => ({ rows: [{ ...ROW, team_id: "team-eng" }] }));
    expect((await new PgRunStore(reader).get("r4"))?.teamId).toBe("team-eng");
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
    expect(calls[0]?.params?.[13]).toBe(JSON.stringify(caseSpec)); // case_spec column, jsonb

    const { client: reader } = fakeClient(() => ({ rows: [{ ...ROW, case_spec: caseSpec }] }));
    const rec = await new PgRunStore(reader).get("r2");
    expect(rec?.caseSpec?.placement?.target).toBe("nomad-x"); // the effective (placement-injected) case survives
  });

  it("round-trips the universal-run shape (mig 0092): kind/class/origin/group stringify on INSERT and map back on read", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(client).create({
      id: "r3",
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      caseId: "c1",
      status: "queued",
      kind: "eval",
      class: "batch",
      lifetime: "task",
      origin: { cause: "schedule", scheduleId: "sch-1" },
      group: { id: "sc-9", role: "case" },
      placement: { where: "runtime", target: "nomad-x" },
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    // Column order (mig 0092 tail, shifted one by team_id in mig 0106): …case_spec($14), kind, class, lifetime,
    // origin, envelope, placement, attach, group_ref, lineage, outputs, created_at, updated_at
    expect(calls[0]?.params?.[14]).toBe("eval");
    expect(calls[0]?.params?.[15]).toBe("batch");
    expect(calls[0]?.params?.[16]).toBe("task");
    expect(calls[0]?.params?.[17]).toBe(JSON.stringify({ cause: "schedule", scheduleId: "sch-1" }));
    expect(calls[0]?.params?.[19]).toBe(JSON.stringify({ where: "runtime", target: "nomad-x" }));
    expect(calls[0]?.params?.[21]).toBe(JSON.stringify({ id: "sc-9", role: "case" }));

    const { client: reader } = fakeClient(() => ({
      rows: [
        {
          ...ROW,
          kind: "eval",
          class: "batch",
          lifetime: "task",
          origin: { cause: "schedule", scheduleId: "sch-1" },
          group_ref: { id: "sc-9", role: "case" },
          placement: { where: "runtime", target: "nomad-x" },
        },
      ],
    }));
    const rec = await new PgRunStore(reader).get("r3");
    expect(rec).toMatchObject({
      kind: "eval",
      class: "batch",
      origin: { cause: "schedule", scheduleId: "sch-1" },
      group: { id: "sc-9", role: "case" }, // group_ref column → the record's `group`
    });
  });

  it("update persists a session patch (P6 close) — pre-fix the key was silently dropped and closedReason never landed", async () => {
    // Caught live: the InMemory store spreads any patch, so only the Pg lane lost `session` — the sandbox
    // row settled succeeded with an empty closedReason.
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const session = {
      image: "alpine:3.20",
      ttlSec: 300,
      expiresAt: "2026-07-30T00:05:00.000Z",
      closedReason: "closed" as const,
    };
    await new PgRunStore(client).update("r9", {
      status: "succeeded",
      session,
      updatedAt: "2026-07-30T00:04:00.000Z",
    });
    expect(calls[0]?.text).toMatch(/session = \$/);
    expect(calls[0]?.params).toContain(JSON.stringify(session));
  });

  it("persists outbox events in the SAME STATEMENT as the write (E0 — data-modifying CTE, no tx seam needed)", async () => {
    const event = {
      id: "ev-1",
      tenant: "acme",
      kind: "run.completed" as const,
      subject: { type: "run", id: "r1" },
      actor: "alice",
      payload: { status: "succeeded" },
      message: "Run r1 succeeded",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    // update + facts → one WITH upd … INSERT INTO everdict_platform_events … statement
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    await new PgRunStore(client).update("r1", { status: "succeeded", updatedAt: "t1" }, [event]);
    expect(calls[0]?.text).toMatch(/WITH upd AS \(UPDATE everdict_runs/);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
    expect(calls[0]?.text).toMatch(/WHERE EXISTS \(SELECT 1 FROM upd\)/); // facts land only if the update matched
    expect(calls[0]?.params).toContain("ev-1");
    expect(calls[0]?.params).toContain("run.completed");

    // create + facts → WITH ins … INSERT INTO everdict_platform_events
    const { client: c2, calls: calls2 } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(c2).create(
      {
        id: "r9",
        tenant: "acme",
        harness: { id: "scripted", version: "0" },
        caseId: "c1",
        status: "queued",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
      [{ ...event, id: "ev-2", kind: "run.submitted" }],
    );
    expect(calls2[0]?.text).toMatch(/WITH ins AS \(INSERT INTO everdict_runs/);
    expect(calls2[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
    expect(calls2[0]?.params).toContain("ev-2");

    // no facts → the plain single-write statements, unchanged
    const { client: c3, calls: calls3 } = fakeClient(() => ({ rows: [ROW] }));
    await new PgRunStore(c3).update("r1", { status: "running", updatedAt: "t2" });
    expect(calls3[0]?.text).not.toMatch(/platform_events/);
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

  it("list scope: default hides children ($3 false); includeChildren = all ($3 true); scorecardId = one batch ($2); runner filter ($4) + limit ($5) + offset ($6)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    const store = new PgRunStore(client);
    // params: [tenant, scorecardId, includeChildren, runnerId, limit, offset, viewer, personalKinds]
    const PERSONAL = ["agent", "sandbox"]; // the audience filter's kind list ($8) — unset viewer ($7) disables it
    const SEEN = null; // the team ceiling ($9) — NULL = nothing is hidden
    await store.list("acme");
    expect(calls[0]?.params).toEqual(["acme", null, false, null, null, 0, null, PERSONAL, SEEN]);
    await store.list("acme", { includeChildren: true });
    expect(calls[1]?.params).toEqual(["acme", null, true, null, null, 0, null, PERSONAL, SEEN]);
    await store.list("acme", { scorecardId: "sc1" });
    expect(calls[2]?.params).toEqual(["acme", "sc1", false, null, null, 0, null, PERSONAL, SEEN]);
    // runner activity feed — jsonb provenance filter + capped
    await store.list("acme", { runnerId: "r1", limit: 20 });
    expect(calls[3]?.params).toEqual(["acme", null, false, "r1", 20, 0, null, PERSONAL, SEEN]);
    expect(calls[3]?.text).toMatch(/result->'provenance'->>'runner' = \$4/);
    expect(calls[3]?.text).toMatch(/LIMIT \$5 OFFSET \$6/);
    // offset pagination — the runner feed's next page skips the first N ($6)
    await store.list("acme", { runnerId: "r1", limit: 20, offset: 40 });
    expect(calls[4]?.params).toEqual(["acme", null, false, "r1", 20, 40, null, PERSONAL, SEEN]);
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

  // The case verdict rides the same derived read as usage, so the run detail can STATE "this case passed"
  // instead of leaving every reader to sum pass badges — and so no client re-implements the authority
  // ranking (the mirrors of it were deleted in re-architecture P1g; the server is the one authority).
  it("derives the case verdict from result.scores by authority rank — ground truth outranks the judge", async () => {
    const store = new InMemoryRunStore();
    await store.create(base);
    expect((await store.get("r1"))?.verdict).toBeUndefined(); // queued, no result

    // A judge that disagrees with the ground-truth grader must not flip the verdict.
    await store.update("r1", {
      status: "succeeded",
      result: {
        ...RESULT,
        scores: [
          { graderId: "pytest", metric: "tests_pass", value: 1, pass: true },
          { graderId: "rubric", metric: "judge", value: 0.2, pass: false },
        ],
      },
    });
    expect((await store.get("r1"))?.verdict).toBe(true);
    expect((await store.list("acme"))[0]?.verdict).toBe(true);
  });

  it("leaves the verdict undefined when no grader decided one (an agent turn, a scoreless run)", async () => {
    const store = new InMemoryRunStore();
    await store.create({ ...base, id: "r2", kind: "agent" });
    await store.update("r2", { status: "succeeded", result: { ...RESULT, scores: [] } });
    const rec = await store.get("r2");
    expect(rec?.verdict).toBeUndefined();
    expect(rec?.usage?.totalTokens).toBe(2); // usage still derives — the two are independent
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

describe("RunStore — the audience filter (personal executions are their owner's)", () => {
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

  it("drops another member's agent turns and shell sessions, keeps the workspace's evals", async () => {
    const store = new InMemoryRunStore();
    await store.create(mk("eval-1", { createdBy: "alice" }));
    await store.create(
      mk("turn-alice", { kind: "agent", createdBy: "alice", origin: { cause: "member", actor: "alice" } }),
    );
    await store.create(mk("shell-alice", { kind: "sandbox", createdBy: "alice" }));
    await store.create(mk("turn-bob", { kind: "agent", createdBy: "bob", origin: { cause: "member", actor: "bob" } }));
    // A personal run nobody is stamped on stays the workspace's — hiding it from everyone would be loss.
    await store.create(mk("turn-orphan", { kind: "agent" }));

    expect((await store.list("acme", { viewer: "bob" })).map((r) => r.id).sort()).toEqual([
      "eval-1",
      "turn-bob",
      "turn-orphan",
    ]);
    expect((await store.list("acme", { viewer: "alice" })).map((r) => r.id).sort()).toEqual([
      "eval-1",
      "shell-alice",
      "turn-alice",
      "turn-orphan",
    ]);
    // No viewer = an internal read (recovery, reapers) — unfiltered, as before.
    expect(await store.list("acme")).toHaveLength(5);
  });

  it("hides a PRIVATE team's runs — a second ceiling beside the audience one, both above the LIMIT", async () => {
    const store = new InMemoryRunStore();
    await store.create(mk("ours", { teamId: "team-web" }));
    await store.create(mk("theirs", { teamId: "team-secret" }));
    await store.create(mk("unowned", {})); // no team = the workspace's
    expect((await store.list("acme", { visibleTeams: ["team-web"] })).map((r) => r.id).sort()) //
      .toEqual(["ours", "unowned"]);
    // undefined = nothing is hidden, never "no teams".
    expect(await store.list("acme")).toHaveLength(3);

    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(client).list("acme", { visibleTeams: ["team-web"] });
    expect(calls[0]?.text).toMatch(/team_id IS NULL OR team_id = ANY\(\$9::text\[\]\)/);
    expect(calls[0]?.params?.[8]).toEqual(["team-web"]);
    expect(calls[0]?.text.indexOf("team_id = ANY")).toBeLessThan(calls[0]?.text.indexOf("LIMIT $5") ?? 0);
  });

  it("Pg impl asks the same question IN the query, so a limited page stays full for the reader", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgRunStore(client).list("acme", { viewer: "alice", limit: 20 });
    const sql = calls[0]?.text ?? "";
    expect(sql).toMatch(/NOT \(kind = ANY\(\$8::text\[\]\)\)/);
    expect(sql).toMatch(/COALESCE\(origin->>'actor', created_by\) = \$7/);
    // The filter sits in the WHERE, above the LIMIT — never applied to an already-limited page.
    expect(sql.indexOf("COALESCE(origin->>'actor', created_by) = $7")).toBeLessThan(sql.indexOf("LIMIT $5"));
    expect(calls[0]?.params?.[6]).toBe("alice");
    expect(calls[0]?.params?.[7]).toEqual(["agent", "sandbox"]);
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
