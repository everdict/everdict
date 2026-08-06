import type { Scorecard } from "@everdict/contracts";
import type { ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPlatformEventStore } from "../activity/platform-event-store.js";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";
import { InMemoryTrajectoryStore, PgTrajectoryStore } from "./trajectory-store.js";

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

  it("list(visibleTeams) hides another team's batch and keeps the unowned ones", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "own", teamId: "team-eng" }));
    await store.create(rec({ id: "theirs", teamId: "team-web" }));
    await store.create(rec({ id: "unowned" })); // `_shared` seeds / pre-team rows belong to the whole workspace
    const mine = await store.list("acme", { visibleTeams: ["team-eng"] });
    expect(mine.map((c) => c.id).sort()).toEqual(["own", "unowned"]);
    // Naming a team is a different question from being allowed to see it — both narrow, and both apply.
    expect((await store.list("acme", { teamId: "team-web", visibleTeams: ["team-eng"] })).map((c) => c.id)).toEqual([]);
    expect((await store.list("acme")).map((c) => c.id).sort()).toEqual(["own", "theirs", "unowned"]);
  });

  it("appends outbox events to the paired platform-event store right after the write (E0 in-memory pair)", async () => {
    const events = new InMemoryPlatformEventStore();
    const store = new InMemoryScorecardStore(events);
    await store.create(rec(), [
      {
        id: "ev-1",
        tenant: "acme",
        kind: "scorecard.submitted",
        subject: { type: "scorecard", id: "sc1" },
        payload: { status: "queued" },
        message: "Scorecard sc1 submitted",
        createdAt: "2026-07-29T00:00:00.000Z",
      },
    ]);
    const appended = await events.list("acme");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ id: "ev-1", kind: "scorecard.submitted" });
    // update on a missing id → no write, no events (the in-memory pair appends only after a matched
    // write — mirrors the Pg WHERE EXISTS guard).
    await store.update("missing", { status: "running" }, [
      {
        id: "ev-2",
        tenant: "acme",
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "missing" },
        payload: {},
        message: "never lands",
        createdAt: "2026-07-29T00:00:00.000Z",
      },
    ]);
    expect(await events.list("acme")).toHaveLength(1);
  });

  it("createdBy (runner)·runtime (placement runtime) are lightweight meta — included in both get and list", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ createdBy: "user-alice", runtime: "self:mac" }));
    expect((await store.get("sc1"))?.createdBy).toBe("user-alice");
    expect((await store.get("sc1"))?.runtime).toBe("self:mac");
    expect((await store.list("acme"))[0]?.createdBy).toBe("user-alice");
    expect((await store.list("acme"))[0]?.runtime).toBe("self:mac");
  });

  it("delete removes the record (true) and reports a missing id as false", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec());
    await expect(store.delete("sc1")).resolves.toBe(true);
    expect(await store.get("sc1")).toBeUndefined();
    await expect(store.delete("sc1")).resolves.toBe(false);
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

  it("list(filter.judge) narrows to batches that applied the judge, at any version (judge-detail evaluation history)", async () => {
    const store = new InMemoryScorecardStore();
    const orchestration = { concurrency: 2, retries: 0 };
    await store.create(
      rec({ id: "a", orchestration: { ...orchestration, judges: [{ id: "clarity", version: "1.0.0" }] } }),
    );
    await store.create(
      rec({ id: "b", orchestration: { ...orchestration, judges: [{ id: "clarity", version: "2.0.0" }] } }),
    );
    await store.create(
      rec({ id: "c", orchestration: { ...orchestration, judges: [{ id: "other-judge", version: "1.0.0" }] } }),
    );
    await store.create(rec({ id: "d" })); // no orchestration at all (pre-field record)
    expect((await store.list("acme", { judge: "clarity" })).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await store.list("acme", { judge: "unknown" })).toEqual([]);
  });

  it("list(filter.kind) separates experiments from scorecards — and 'scorecard' matches every pre-field record", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "a", kind: "experiment" }));
    await store.create(rec({ id: "b" })); // a real scorecard (kind unset — every pre-mig-0093 row looks like this)
    expect((await store.list("acme", { kind: "experiment" })).map((r) => r.id)).toEqual(["a"]);
    expect((await store.list("acme", { kind: "scorecard" })).map((r) => r.id)).toEqual(["b"]);
    expect(await store.list("acme")).toHaveLength(2); // unset = everything (the web list shows both, badged)
    expect((await store.get("a"))?.kind).toBe("experiment");
  });

  it("list(filter.causedByRunId) narrows to the batches a run caused (§5.5 cascade-cancel walk)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "a", origin: { source: "mcp", causedByRunId: "run-agent" } }));
    await store.create(rec({ id: "b", origin: { source: "mcp", causedByRunId: "other-run" } }));
    await store.create(rec({ id: "c", origin: { source: "web" } }));
    expect((await store.list("acme", { causedByRunId: "run-agent" })).map((r) => r.id)).toEqual(["a"]);
  });

  it("list(filter.scheduleId) narrows to the runs a schedule fired (origin.scheduleId — schedule-detail run history)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(rec({ id: "a", origin: { source: "schedule", scheduleId: "sch-1" } }));
    await store.create(rec({ id: "b", origin: { source: "schedule", scheduleId: "sch-2" } }));
    await store.create(rec({ id: "c", origin: { source: "web" } })); // a manual run — no scheduleId
    await store.create(rec({ id: "d" })); // no origin at all (pre-field record)
    expect((await store.list("acme", { scheduleId: "sch-1" })).map((r) => r.id)).toEqual(["a"]);
    expect(await store.list("acme", { scheduleId: "unknown" })).toEqual([]);
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
    expect(calls[0]?.params?.[2]).toBeNull(); // no kind (rec default = scorecard; mig 0093)
    expect(calls[0]?.params?.[9]).toBeNull(); // no models (rec default)
    expect(calls[0]?.params?.[10]).toBeNull(); // no judge_models
    expect(calls[0]?.params?.[12]).toBe("user-alice"); // created_by (runner)
    expect(calls[0]?.params?.[13]).toBeNull(); // no team_id (unowned)
    expect(calls[0]?.params?.[14]).toBeNull(); // no runtime
  });

  it("create persists the owning team, and list SELECTs it back (mig 0106 — the column existed, nothing wrote it)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).create(rec({ teamId: "team-eng" }));
    expect(calls[0]?.text).toMatch(/created_by, team_id/);
    expect(calls[0]?.params?.[13]).toBe("team-eng");

    const { client: c2, calls: calls2 } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(c2).list("acme");
    expect(calls2[0]?.text).toMatch(/SELECT[\s\S]*team_id/); // a list row without the owner cannot be attributed to a team
  });

  it("list(filter.teamId) narrows in SQL — the team page asks the store, not the caller", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { teamId: "team-eng" });
    expect(calls[0]?.text).toMatch(/team_id = \$/);
    expect(calls[0]?.params).toContain("team-eng");
  });

  it("list(filter.visibleTeams) keeps unowned rows and refuses the rest — including for a caller on NO team", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { visibleTeams: ["team-eng"] });
    expect(calls[0]?.text).toMatch(/\(team_id IS NULL OR team_id = ANY\(\$\d+::text\[\]\)\)/);
    expect(calls[0]?.params).toContainEqual(["team-eng"]);

    // [] is an answer ("on no team"), not an absence — dropping the condition would show the whole workspace.
    const { client: c2, calls: calls2 } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(c2).list("acme", { visibleTeams: [] });
    expect(calls2[0]?.text).toMatch(/team_id IS NULL OR team_id = ANY/);
  });

  it("list(filter.causedByRunId) narrows in SQL on the persisted origin (cascade-cancel walk)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { causedByRunId: "run-agent" });
    expect(calls[0]?.text).toMatch(/origin->>'causedByRunId' = \$/);
    expect(calls[0]?.params).toContain("run-agent");
  });

  it("list(filter.kind) narrows in SQL — 'scorecard' also matches every pre-mig-0093 NULL row", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { kind: "experiment" });
    expect(calls[0]?.text).toMatch(/kind = 'experiment'/);
    const { client: c2, calls: calls2 } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(c2).list("acme", { kind: "scorecard" });
    expect(calls2[0]?.text).toMatch(/kind IS NULL OR kind <> 'experiment'/);
  });

  it("persists outbox events in the SAME STATEMENT as the write (E0 — data-modifying CTE, same as PgRunStore)", async () => {
    const event = {
      id: "ev-1",
      tenant: "acme",
      kind: "scorecard.completed" as const,
      subject: { type: "scorecard", id: "sc1" },
      actor: "alice",
      payload: { status: "succeeded", passRate: 1 },
      message: "Scorecard sc1 succeeded",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    // update + facts → one WITH upd … INSERT INTO everdict_platform_events … statement
    const { client, calls } = fakeClient(() => ({ rows: [ROW] }));
    await new PgScorecardStore(client).update("sc1", { status: "succeeded", updatedAt: "t1" }, [event]);
    expect(calls[0]?.text).toMatch(/WITH upd AS \(UPDATE everdict_scorecards/);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
    expect(calls[0]?.text).toMatch(/WHERE EXISTS \(SELECT 1 FROM upd\)/); // facts land only if the update matched
    expect(calls[0]?.params).toContain("ev-1");
    expect(calls[0]?.params).toContain("scorecard.completed");

    // create + facts → WITH ins … INSERT INTO everdict_platform_events
    const { client: c2, calls: calls2 } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(c2).create(rec(), [{ ...event, id: "ev-2", kind: "scorecard.submitted" }]);
    expect(calls2[0]?.text).toMatch(/WITH ins AS \(INSERT INTO everdict_scorecards/);
    expect(calls2[0]?.text).toMatch(/INSERT INTO everdict_platform_events/);
    expect(calls2[0]?.params).toContain("ev-2");

    // no facts → the plain single-write statements, unchanged
    const { client: c3, calls: calls3 } = fakeClient(() => ({ rows: [ROW] }));
    await new PgScorecardStore(c3).update("sc1", { status: "running", updatedAt: "t2" });
    expect(calls3[0]?.text).not.toMatch(/platform_events/);
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

  it("analysisRef → update writes the analysis_ref column (set at finalize) and get maps it back (detail-only download ref)", async () => {
    // Regression: the finalize path sets analysisRef via succeed()→store.update; the store used to ignore the field,
    // so with Postgres the ref was silently dropped and the download link never appeared even when the object store held it.
    const ref = "https://minio.corp.io/artifacts/analyses/sc1.json?X-Amz-Signature=abc";
    const upd = fakeClient(() => ({ rows: [{ ...ROW, analysis_ref: ref }] }));
    const updated = await new PgScorecardStore(upd.client).update("sc1", { analysisRef: ref });
    expect(upd.calls[0]?.text).toMatch(/analysis_ref = \$1/); // pre-fix: ignored → sets empty → a SELECT, never this UPDATE
    expect(upd.calls[0]?.params?.[0]).toBe(ref);
    expect(updated?.analysisRef).toBe(ref); // row.analysis_ref → record.analysisRef (get mapping)
  });

  it("create → INSERT carries the analysis_ref column + value (so a ref set on a fresh record survives insert)", async () => {
    const ref = "https://minio.corp.io/artifacts/analyses/sc1.json";
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).create(rec({ analysisRef: ref }));
    expect(calls[0]?.text).toMatch(/analysis_ref/); // column present in the INSERT list (absent pre-fix)
    expect(calls[0]?.params?.[19]).toBe(ref); // positioned after manifest+scorecard ($19), before sink_export
  });

  it("list(filter) → dataset_id/status clauses in the SQL WHERE + parameterization (avoids a full scan)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { dataset: "d1", status: "succeeded" });
    expect(calls[0]?.text).toMatch(/dataset_id = \$2/);
    expect(calls[0]?.text).toMatch(/status = \$3/);
    expect(calls[0]?.params).toEqual(["acme", "d1", "succeeded"]);
  });

  it("list(filter.judge) → jsonb containment on orchestration.judges (matches the id at any version)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { judge: "clarity" });
    expect(calls[0]?.text).toMatch(/orchestration->'judges' @> \$2::jsonb/);
    expect(calls[0]?.params).toEqual(["acme", JSON.stringify([{ id: "clarity" }])]);
  });

  it("list(filter.scheduleId) → origin->>'scheduleId' clause in the SQL WHERE (schedule run history)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgScorecardStore(client).list("acme", { scheduleId: "sch-1" });
    expect(calls[0]?.text).toMatch(/origin->>'scheduleId' = \$2/);
    expect(calls[0]?.params).toEqual(["acme", "sch-1"]);
  });

  it("delete → parameterized DELETE; RETURNING distinguishes deleted (true) from missing (false)", async () => {
    const hit = fakeClient(() => ({ rows: [{ id: "sc1" }] }));
    await expect(new PgScorecardStore(hit.client).delete("sc1")).resolves.toBe(true);
    expect(hit.calls[0]?.text).toMatch(/DELETE FROM everdict_scorecards WHERE id = \$1/);
    expect(hit.calls[0]?.params).toEqual(["sc1"]);

    const miss = fakeClient(() => ({ rows: [] }));
    await expect(new PgScorecardStore(miss.client).delete("nope")).resolves.toBe(false);
  });
});

describe("TrajectoryStore — the owned evidence copy (P5 rung 1)", () => {
  const events = [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }];

  it("seals once per emitter and NEVER rewrites — a re-offer wins nothing, cross-tenant reads miss", async () => {
    const store = new InMemoryTrajectoryStore();
    const first = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: events as never });
    expect(first.eventCount).toBe(1);
    expect(first.created).toBe(true);
    const again = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: [] });
    // Idempotent — evidence is never rewritten; `created:false` is how the perception decorator knows
    // a re-offer must not re-announce (E4 announce-once).
    expect(again).toEqual({ ...first, created: false });
    expect((await store.get("acme", "r1"))?.events).toHaveLength(1);
    expect(await store.get("rival", "r1")).toBeUndefined(); // tenant-scoped
  });

  it("a second EMITTER joins as its own plane instead of being mistaken for a retry", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({ runId: "r1", tenant: "acme", source: "run", events: events as never });
    const service = await store.seal({
      runId: "r1",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      t0: "2026-07-31T00:00:00.000Z",
      events: [{ t: 5, kind: "span", name: "GET /cart", durationMs: 12 }] as never,
    });
    expect(service.created).toBe(true);
    expect(service.eventCount).toBe(2); // the trajectory now holds BOTH planes

    const sealed = await store.get("acme", "r1");
    expect(sealed?.segments.map((s) => s.emitter)).toEqual(["run", "service:checkout"]);
    expect(sealed?.segments[1]?.t0).toBe("2026-07-31T00:00:00.000Z"); // the plane's own alignment anchor
    // The EXECUTION's record stays what a judge reads — a service's spans never displace the agent's trace.
    expect(sealed?.executionEmitter).toBe("run");
    expect(sealed?.events).toHaveLength(1);
    expect(sealed?.events[0]).toMatchObject({ kind: "llm_call" });
  });

  it("a run whose services sealed FIRST still keeps the agent's own trace as the judged evidence", async () => {
    // The topology shape: services push spans through the door while the case runs, so the run's own seal
    // arrives last. Pre-multi-plane that seal was silently dropped.
    const store = new InMemoryTrajectoryStore();
    await store.seal({
      runId: "r1",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      events: [{ t: 0, kind: "span", name: "GET /cart" }] as never,
    });
    const run = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: events as never });
    expect(run.created).toBe(true);

    const sealed = await store.get("acme", "r1");
    expect(sealed?.executionEmitter).toBe("run");
    expect(sealed?.events[0]).toMatchObject({ kind: "llm_call" });
    expect(sealed?.meta.source).toBe("otlp"); // how the trajectory FIRST arrived
    expect(sealed?.meta.eventCount).toBe(2);
  });

  it("keeps OWNED evidence for its owner — the browse page drops another member's, in the query", async () => {
    // An agent turn's transcript and a shell session's record are the member's own (`runAudience`). The ledger
    // is read by id, with no run row beside it, so the owner rides the row.
    const store = new InMemoryTrajectoryStore();
    await store.seal({ runId: "turn-a", tenant: "acme", source: "run", owner: "alice", events: events as never });
    await store.seal({ runId: "eval-1", tenant: "acme", source: "run", events: events as never });

    expect((await store.list("acme", { viewer: "alice" })).items.map((m) => m.runId).sort()).toEqual([
      "eval-1",
      "turn-a",
    ]);
    // Bob sees the workspace's evidence and none of Alice's.
    expect((await store.list("acme", { viewer: "bob" })).items.map((m) => m.runId)).toEqual(["eval-1"]);
    // An internal read (retention, metering) passes no viewer and still sees everything.
    expect((await store.list("acme")).items).toHaveLength(2);
    expect((await store.get("acme", "turn-a"))?.meta.owner).toBe("alice");
  });

  it("Pg impl filters the owner IN the WHERE (a page filtered after LIMIT would be short)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgTrajectoryStore(client).list("acme", { viewer: "alice", limit: 10 });
    expect(calls[0]?.text).toMatch(/\(owner IS NULL OR owner = \$2\)/);
    expect(calls[0]?.params).toEqual(["acme", "alice"]);
    // The cursor keeps its own placeholders when both are present.
    const paged = fakeClient(() => ({ rows: [] }));
    await new PgTrajectoryStore(paged.client).list("acme", {
      viewer: "alice",
      cursor: Buffer.from("2026-08-03T00:00:00.000Z|r1", "utf8").toString("base64url"),
    });
    expect(paged.calls[0]?.text).toMatch(/\(sealed_at, run_id\) < \(\$2::timestamptz, \$3\)/);
    expect(paged.calls[0]?.text).toMatch(/\(owner IS NULL OR owner = \$4\)/);
    expect(paged.calls[0]?.params).toEqual(["acme", "2026-08-03T00:00:00.000Z", "r1", "alice"]);
  });

  it("carries what a row IS, and filters on it — a browse page of bare uuids cannot be read", async () => {
    // Evidence you cannot recognize is indistinguishable from evidence that is not there: every row used to
    // render `<uuid> · run · N events`, so a member could not find the agent conversation they just ran.
    const store = new InMemoryTrajectoryStore();
    await store.seal({
      runId: "turn-a",
      tenant: "acme",
      source: "run",
      kind: "agent",
      label: "sentinel",
      events: events as never,
    });
    await store.seal({
      runId: "case-1",
      tenant: "acme",
      source: "run",
      kind: "eval",
      label: "swe-bench-7",
      events: events as never,
    });

    expect((await store.list("acme", { kind: "agent" })).items).toMatchObject([
      { runId: "turn-a", kind: "agent", label: "sentinel" },
    ]);
    expect((await store.list("acme", { kind: "eval" })).items.map((m) => m.label)).toEqual(["swe-bench-7"]);
    expect((await store.list("acme")).items).toHaveLength(2); // no filter = the whole ledger
    expect((await store.get("acme", "turn-a"))?.meta).toMatchObject({ kind: "agent", label: "sentinel" });
  });

  it("Pg impl filters the kind IN the WHERE too — beside the owner, before the LIMIT", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgTrajectoryStore(client).list("acme", { viewer: "alice", kind: "agent" });
    expect(calls[0]?.text).toMatch(/kind = \$3/);
    expect(calls[0]?.params).toEqual(["acme", "alice", "agent"]);
  });

  it("meters ingestion from the store itself and sweeps retention by cutoff (N3)", async () => {
    const store = new InMemoryTrajectoryStore();
    await store.seal({ runId: "old", tenant: "acme", source: "otlp", events: events as never });
    // Backdate by re-seeding through the public surface only: seal stamps now(), so use ingestedSince's
    // exclusive bound instead — everything sealed "now" is inside a 1h window and outside a future one.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(await store.ingestedSince("acme", hourAgo)).toEqual({ trajectories: 1, events: 1 });
    expect(await store.ingestedSince("rival", hourAgo)).toEqual({ trajectories: 0, events: 0 }); // tenant-scoped
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await store.ingestedSince("acme", future)).events).toBe(0);

    // Retention: a future cutoff removes today's rows; the sweep reports the count.
    expect(await store.deleteOlderThan(future)).toBe(1);
    expect(await store.get("acme", "old")).toBeUndefined();
    expect(await store.deleteOlderThan(future)).toBe(0); // idempotent on an empty store
  });

  it("Pg impl meters and sweeps with tenant-scoped aggregate / cutoff DELETE (N3)", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (text.includes("SELECT count(*)")) return { rows: [{ trajectories: "2", events: "7" }] as never[] };
        if (text.startsWith("DELETE")) return { rows: [{ run_id: "a" }, { run_id: "b" }] as never[] };
        return { rows: [] as never[] };
      },
    };
    const store = new PgTrajectoryStore(client);
    expect(await store.ingestedSince("acme", "2026-07-30T00:00:00.000Z")).toEqual({ trajectories: 2, events: 7 });
    expect(calls[0]?.text).toMatch(/tenant = \$1 AND sealed_at > \$2/);
    expect(await store.deleteOlderThan("2026-07-01T00:00:00.000Z")).toBe(2);
    expect(calls[1]?.text).toMatch(/DELETE FROM everdict_trajectories WHERE sealed_at < \$1/);
    // Every plane's events ride the meter, not just the header's — a service segment is stored evidence too.
    expect(calls[0]?.text).toMatch(/SUM\(event_count \+ segment_event_count\)/);
  });

  it("Pg impl seals with ON CONFLICT DO NOTHING (first write wins at the row level)", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (text.includes("FROM everdict_trajectory_segments")) return { rows: [] } as never;
        if (text.startsWith("SELECT"))
          return {
            rows: [
              {
                run_id: "r1",
                tenant: "acme",
                source: "run",
                emitter: "run",
                event_count: 1,
                segment_event_count: 0,
                body: events,
                t0: null,
                sealed_at: "2026-07-30T00:00:00.000Z",
              },
            ],
          } as never;
        return { rows: [] } as never;
      },
    };
    const store = new PgTrajectoryStore(client);
    const meta = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: events as never });
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_trajectories/);
    expect(calls[0]?.text).toMatch(/ON CONFLICT \(run_id\) DO NOTHING/);
    expect(meta.source).toBe("run"); // read back — a lost race returns the FIRST seal's meta
    expect(meta.created).toBe(false); // same emitter: a retry writes nothing
    expect((await store.get("acme", "r1"))?.meta.eventCount).toBe(1);
  });

  it("Pg impl keeps a LOSING seal from another emitter as its own segment row", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        // The header insert loses the race; the segment insert takes.
        if (text.includes("INSERT INTO everdict_trajectory_segments")) return { rows: [{ run_id: "r1" }] } as never;
        if (text.startsWith("INSERT")) return { rows: [] } as never;
        if (text.includes("FROM everdict_trajectory_segments")) return { rows: [] } as never;
        if (text.startsWith("SELECT"))
          return {
            rows: [
              {
                run_id: "r1",
                tenant: "acme",
                source: "otlp",
                emitter: "service:checkout",
                event_count: 3,
                segment_event_count: 0,
                t0: null,
                sealed_at: "2026-07-30T00:00:00.000Z",
              },
            ],
          } as never;
        return { rows: [] } as never;
      },
    };
    const store = new PgTrajectoryStore(client);
    const meta = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: events as never });
    expect(meta.created).toBe(true); // a NEW plane, not a rejected retry
    const segmentInsert = calls.find((c) => c.text.includes("INSERT INTO everdict_trajectory_segments"));
    expect(segmentInsert?.text).toMatch(/ON CONFLICT \(run_id, emitter\) DO NOTHING/);
    expect(segmentInsert?.params?.[1]).toBe("run"); // the emitter this seal belongs to
    // The denormalized counter keeps the browse row and the ingestion meter honest.
    expect(calls.some((c) => /SET segment_event_count = segment_event_count \+ \$1/.test(c.text))).toBe(true);
  });
});
