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

  // The store must NOT interpret evidence: which policy judged a record is a domain question it cannot
  // answer (a scorecard child is judged under its PARENT's stamped policy). The served verdict is derived
  // in the application query layer (RunService.withVerdicts) — re-deriving it here under the default ladder
  // made the run detail disagree with the scorecard case dialog about the same CaseResult.
  it("never derives a verdict — the store serves evidence, the application layer interprets it", async () => {
    const store = new InMemoryRunStore();
    await store.create(base);
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
    const rec = await store.get("r1");
    expect(rec?.verdict).toBeUndefined(); // interpretation is not the adapter's job
    expect((await store.list("acme"))[0]?.verdict).toBeUndefined();
    expect(rec?.usage?.totalTokens).toBe(2); // usage still derives — a mechanical sum, not an interpretation
  });
});

describe("InMemoryRunStore — the live session pool", () => {
  const session = (id: string, extra: Partial<RunRecord>, expiresAt: string): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "world", version: "1" },
    caseId: "img",
    status: "running",
    kind: "sandbox",
    lifetime: "session",
    trigger: "sandbox",
    session: { image: "img", ttlSec: 900, expiresAt },
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  });
  const soon = (): string => new Date(Date.now() + 600_000).toISOString();

  it("counts what the WORKSPACE is holding open, across whatever process opened it", async () => {
    const store = new InMemoryRunStore();
    await store.create(session("s1", {}, soon()));
    await store.create(session("s2", { tenant: "other" }, soon()));
    await store.create(session("s3", { trigger: "browser" }, soon())); // a different pool
    await store.create(session("s4", { status: "succeeded" }, soon())); // already closed
    await store.create(session("s5", { lifetime: "task", trigger: "file" }, soon())); // not a session at all

    expect((await store.liveSessions({ tenant: "acme", trigger: "sandbox" })).map((r) => r.id)).toEqual(["s1"]);
    expect((await store.liveSessions({ trigger: "sandbox" })).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });

  it("carries what a refusal needs to be actionable: whose it is, which agent, and when it frees", async () => {
    const store = new InMemoryRunStore();
    const at = soon();
    await store.create(
      session(
        "s1",
        { createdBy: "alice", session: { image: "i", ttlSec: 900, expiresAt: at, agent: { agentId: "a1" } } },
        at,
      ),
    );

    expect(await store.liveSessions({ tenant: "acme" })).toEqual([
      { id: "s1", tenant: "acme", createdBy: "alice", agentId: "a1", expiresAt: at },
    ]);
  });
});

describe("PgRunStore — which replica drives the row (multi-replica boot recovery)", () => {
  const queued: RunRecord = {
    id: "r9",
    tenant: "acme",
    harness: { id: "scripted", version: "0" },
    caseId: "c1",
    status: "queued",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };

  it("stamps the writing process as the driver — ownership needs no submit path to thread it", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));

    await new PgRunStore(client, "cp-abc").create(queued);

    expect(calls[0]?.text).toMatch(/session, owner_replica, created_at/);
    expect(calls[0]?.params?.[25]).toBe("cp-abc");
  });

  it("leaves the owner NULL when the store has no replica identity (the single-process shape)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));

    await new PgRunStore(client).create(queued);

    expect(calls[0]?.params?.[25]).toBeNull();
  });

  it("transfers ownership on update — the replica that resumes an orphan becomes its driver", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));

    await new PgRunStore(client, "cp-abc").update("r9", { ownerReplica: "cp-new" });

    expect(calls[0]?.text).toMatch(/UPDATE everdict_runs SET owner_replica = \$1/);
    expect(calls[0]?.params).toEqual(["cp-new", "r9"]);
  });
});

describe("RunStore — the scheduler's admission ledger (multi-replica tenant quota)", () => {
  const run = (id: string, extra: Partial<RunRecord>): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "scripted", version: "0" },
    caseId: "c1",
    status: "running",
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  });

  it("counts a workspace's running eval work — the fact every replica must share", async () => {
    const store = new InMemoryRunStore();
    await store.create(run("r1", {}));
    await store.create(run("r2", { kind: "eval" }));
    await store.create(run("r3", { tenant: "other" }));

    expect(await store.inFlightByTenant()).toEqual({ acme: 2, other: 1 });
  });

  it("leaves out what the quota must not count: queued work, sessions, and other run families", async () => {
    const store = new InMemoryRunStore();
    // Queued = still waiting in some replica's scheduler queue. Counting it against the quota that decides
    // whether it may start would deadlock a workspace sitting at its cap.
    await store.create(run("r1", { status: "queued" }));
    await store.create(run("r2", { status: "succeeded" }));
    // A held-open session is bounded by the session pool's own cap, not by the eval quota.
    await store.create(run("r3", { kind: "sandbox", lifetime: "session" }));
    await store.create(run("r4", { kind: "agent" }));

    expect(await store.inFlightByTenant()).toEqual({});
  });

  it("Pg asks the same question in SQL — grouped, active-only, one read per scheduler drain", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ tenant: "acme", n: "3" }] }));
    const store = new PgRunStore(client);

    expect(await store.inFlightByTenant()).toEqual({ acme: 3 }); // count(*) comes back as a numeric string

    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("FROM everdict_runs");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("kind IS NULL OR kind = 'eval'");
    expect(sql).toContain("lifetime IS NULL OR lifetime <> 'session'");
    expect(sql).toContain("GROUP BY tenant");
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

  it("keeps a BACKGROUND agent run on everyone's list — headless automation is workspace observability", async () => {
    // Regression (O2): the same activation was workspace-visible through its session door (the session store
    // writes visibility: "workspace" by design) while its run row hid behind the personal-kind filter — one
    // work item, two audiences. The class column already says which kind of agent run this is.
    const store = new InMemoryRunStore();
    await store.create(
      mk("headless-alice", {
        kind: "agent",
        class: "background",
        createdBy: "alice",
        origin: { cause: "event", actor: "alice", executor: "agent:watcher" },
      }),
    );
    await store.create(
      mk("chat-alice", {
        kind: "agent",
        class: "interactive",
        createdBy: "alice",
        origin: { cause: "member", actor: "alice", executor: "agent:helper" },
      }),
    );
    const bobSees = (await store.list("acme", { viewer: "bob" })).map((r) => r.id);
    expect(bobSees).toContain("headless-alice"); // fleet observability
    expect(bobSees).not.toContain("chat-alice"); // still alice's conversation
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
    // The background-agent pass rides IN the same clause: headless automation is workspace observability
    // (runAudience's class rule), so the SQL restatement must open it too — before the LIMIT like the rest.
    expect(sql).toMatch(/OR \(kind = 'agent' AND class = 'background'\)/);
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

  it("survives losing the tracking-table creation race — two booting processes, one catalog winner", async () => {
    // CREATE TABLE IF NOT EXISTS races its own catalog insert under concurrency: both processes pass
    // the existence check, the loser gets 23505 (pg_type) or 42P07. The table exists either way.
    for (const code of ["23505", "42P07"]) {
      const { client } = fakeClient((text) => {
        if (text.includes("CREATE TABLE IF NOT EXISTS everdict_schema_migrations")) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code });
        }
        return { rows: [] };
      });
      const res = await migrate(client, { migrations: [{ name: "0001_a.sql", sql: "CREATE TABLE a();" }] });
      expect(res.applied).toEqual(["0001_a.sql"]); // the loser proceeds — the winner made the table
    }
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

// C12 (TRUST-07): the hard-quota permit. The RACE itself is certified against real Postgres
// (fleet-admission.trust.test.ts); what the fake pins here is the STATEMENT SHAPE the guarantee rests on —
// the claim must be one UPDATE whose predicate re-evaluates under the row lock, never a count-then-insert.
describe("PgRunStore admission permits (AdmissionLedger.tryAdmit)", () => {
  it("claims with a single predicate-guarded counter UPDATE and reports the claim count", async () => {
    const { client, calls } = fakeClient((text) => {
      if (text.includes("AS admitted")) return { rows: [{ held: 0, admitted: 1 }] };
      return { rows: [] };
    });
    const store = new PgRunStore(client);
    const admitted = await store.tryAdmit("acme", "permit-1", 5);
    expect(admitted).toBe(true);
    const claim = calls.find((c) => c.text.includes("in_flight < $3"));
    expect(claim).toBeDefined();
    // The race-proof shape: the quota predicate lives INSIDE the UPDATE (EvalPlanQual re-check), and the
    // permit row is written from the claim, so the two can never disagree.
    expect(claim?.text).toMatch(/UPDATE everdict_tenant_admission_counters/);
    expect(claim?.text).toMatch(/INSERT INTO everdict_tenant_admissions/);
    // CONSERVATION: the counter arm is guarded on the permit's absence, so one permit id can never claim twice.
    expect(claim?.text).toMatch(/NOT EXISTS \(SELECT 1 FROM existing\)/);
    expect(claim?.params).toEqual(["acme", "permit-1", 5]);
    // Self-heal precedes the claim: LAPSED-LEASE permits (not merely old ones — renewed_at is the lease) are
    // reaped fleet-wide with each tenant's counter decremented by exactly its losses. Global sweep: an idle
    // tenant's leaks heal on any admission, not only its own next ask.
    const heal = calls.find((c) => c.text.includes("interval '30 minutes'"));
    expect(heal?.text).toMatch(/renewed_at < now\(\)/);
    expect(heal?.text).not.toMatch(/tenant = \$1 AND renewed_at/); // no tenant scope on the sweep
    expect(heal?.text).toMatch(/greatest\(0, c\.in_flight - losses\.n\)/);
  });

  it("renewing a lease touches renewed_at for exactly the held permits — and an empty renewal never queries", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgRunStore(client);
    await store.renewAdmissions(["p1", "p2"]);
    expect(calls[0]?.text).toMatch(/SET renewed_at = now\(\) WHERE permit_id = ANY\(\$1\)/);
    expect(calls[0]?.params).toEqual([["p1", "p2"]]);
    await store.renewAdmissions([]);
    expect(calls).toHaveLength(1); // no round-trip for nothing
  });

  it("a retry of an already-committed claim answers held — success without a second increment", async () => {
    const { client } = fakeClient((text) => {
      if (text.includes("AS admitted")) return { rows: [{ held: 1, admitted: 0 }] };
      return { rows: [] };
    });
    const store = new PgRunStore(client);
    // The lost-response retry: the permit row exists, the counter arm was NOT-EXISTS-guarded away — the
    // same right is re-answered as success, never re-claimed. (The behavior itself is certified against
    // real Postgres in fleet-admission.trust.test.ts; the fake pins the contract of the two arms.)
    expect(await store.tryAdmit("acme", "permit-1", 5)).toBe(true);
  });

  it("a refused claim answers false without writing a permit", async () => {
    const { client } = fakeClient((text) => {
      if (text.includes("AS admitted")) return { rows: [{ admitted: 0 }] };
      return { rows: [] };
    });
    const store = new PgRunStore(client);
    expect(await store.tryAdmit("acme", "permit-2", 0)).toBe(false);
  });

  it("release deletes the permit and decrements its tenant's counter — idempotent by construction", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    const store = new PgRunStore(client);
    await store.releaseAdmission("permit-1");
    const release = calls[0];
    expect(release?.text).toMatch(/DELETE FROM everdict_tenant_admissions WHERE permit_id = \$1/);
    expect(release?.text).toMatch(/greatest\(0, c.in_flight - 1\)/);
    expect(release?.params).toEqual(["permit-1"]);
  });
});

describe("InMemoryRunStore admission permits — the single-process twin", () => {
  it("admits up to the quota, refuses past it, and frees on release", async () => {
    const store = new InMemoryRunStore();
    expect(await store.tryAdmit("acme", "p1", 2)).toBe(true);
    expect(await store.tryAdmit("acme", "p2", 2)).toBe(true);
    expect(await store.tryAdmit("acme", "p3", 2)).toBe(false); // quota held
    expect(await store.tryAdmit("other", "q1", 2)).toBe(true); // per-tenant
    await store.releaseAdmission("p1");
    await store.releaseAdmission("p1"); // double release is a no-op
    expect(await store.tryAdmit("acme", "p4", 2)).toBe(true);
    expect(await store.tryAdmit("acme", "p5", 2)).toBe(false);
  });

  it("a retry with the permit id it already holds is the same right — true, even at quota", async () => {
    const store = new InMemoryRunStore();
    expect(await store.tryAdmit("acme", "p1", 1)).toBe(true);
    // The lost-response retry: the entry re-asks with the id it was already granted. Counting the held
    // permit against its own retry would refuse an at-quota entry its own admission forever.
    expect(await store.tryAdmit("acme", "p1", 1)).toBe(true);
    expect(await store.tryAdmit("acme", "p2", 1)).toBe(false); // a DIFFERENT permit still refused at quota
  });
});
