import type { Dispatcher } from "@everdict/backends";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  type Dataset,
  type HarnessTemplateSpec,
  NotFoundError,
  type Scorecard,
  type TraceEvent,
} from "@everdict/core";
import { InMemoryRunStore, InMemoryScorecardStore, type ScorecardRecord } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@everdict/registry";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { describe, expect, it } from "vitest";
import { ScorecardService } from "./scorecard-service.js";
import type { CaseExportStream } from "./trace-sink-service.js";

const dispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("unused in diff tests");
  },
};

// One tests-pass score per case. Flip pass to create a regression/improvement.
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

describe("ScorecardService.submit — requireRuntime policy (no local fallback)", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    ...over,
  });
  const build = (requireRuntime: boolean) =>
    new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets: new InMemoryDatasetRegistry(),
      requireRuntime,
    });

  it("policy ON + no runtime → 400 (BadRequest) — fail-fast before resolving the dataset", async () => {
    await expect(build(true).submit(input())).rejects.toBeInstanceOf(BadRequestError);
  });

  it("policy ON + a runtime (registered runtime/self) passes the gate — proceeds to the next step (NotFound because the dataset is missing)", async () => {
    // NotFound rather than BadRequest = proof it passed the runtime gate (the gate only checks that a target exists).
    await expect(build(true).submit(input({ runtime: "self:laptop" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("policy OFF (dev) passes the gate without a runtime (existing behavior unchanged)", async () => {
    await expect(build(false).submit(input())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScorecardService.diff", () => {
  it("reports pass transitions as regression/improvement", async () => {
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

  it("missing / other-workspace scorecard → NotFoundError (404)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("other", { tenant: "beta", scorecard: scorecard(true) }));
    await expect(svc(store).diff("acme", "base", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).diff("acme", "base", "other")).rejects.toBeInstanceOf(NotFoundError); // other workspace
  });

  it("not completed (no scorecard) → BadRequestError (400)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("queued", { status: "queued" }));
    await expect(svc(store).diff("acme", "base", "queued")).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("ScorecardService.leaderboard", () => {
  // A completed scorecard with a judge passRate + primary model.
  const scored = (id: string, harnessVersion: string, model: string, passRate: number): Partial<ScorecardRecord> => ({
    harness: { id: "h", version: harnessVersion },
    summary: [{ metric: "judge", count: 10, mean: passRate, passRate }],
    models: { observed: [model], primary: model },
  });

  it("ranks a dataset's (harness × model) descending by metric and scopes to the workspace", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("a", scored("a", "1", "gpt-5", 0.6)));
    await store.create(record("b", scored("b", "2", "claude-opus-4-8", 0.9)));
    await store.create(record("other", { ...scored("other", "2", "x", 1.0), tenant: "beta" })); // other workspace
    const lb = await svc(store).leaderboard("acme", { datasetId: "d", metric: "judge" });
    expect(lb.rows.map((r) => [r.rank, r.harness.version, r.model, r.score])).toEqual([
      [1, "2", "claude-opus-4-8", 0.9],
      [2, "1", "gpt-5", 0.6],
    ]);
    expect(lb.rows.some((r) => r.model === "x")).toBe(false); // beta workspace excluded
  });
});

describe("ScorecardService.backfillModels", () => {
  // A completed scorecard with an observed model in the trace (no models field, like an old record).
  const scWithModel = (model: string): Scorecard => ({
    suiteId: "d",
    harness: "h@1",
    results: [
      {
        caseId: "c1",
        harness: "h@1",
        trace: [{ t: 0, kind: "llm_call", model }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      },
    ],
  });

  it("fills succeeded records lacking models from stored-trace observations (idempotent; skips incomplete / existing models)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("old", { scorecard: scWithModel("gpt-4o") })); // no models
    await store.create(record("queued", { status: "queued" })); // no output → skip
    await store.create(
      record("already", { scorecard: scWithModel("o3"), models: { observed: ["o3"], primary: "o3" } }),
    );

    const res = await svc(store).backfillModels("acme");
    expect(res.updated).toBe(1); // old only
    expect((await store.get("old"))?.models?.primary).toBe("gpt-4o");

    // idempotent: the second run has nothing to fill.
    expect((await svc(store).backfillModels("acme")).updated).toBe(0);
  });
});

// A dataset with a single case (c1). The target for pull-ingest ordering.
const datasetWithCase = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [
    {
      id: "c1",
      env: { kind: "repo", source: { files: { "a.txt": "x" } } },
      task: "do",
      graders: [],
      timeoutSec: 1800,
      tags: [],
    },
  ],
  tags: [],
});

// Poll until the background trackPull finishes (terminal status).
async function waitTerminal(store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> {
  for (let i = 0; i < 50; i++) {
    const rec = await store.get(id);
    if (rec && (rec.status === "succeeded" || rec.status === "failed")) return rec;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("pull ingest did not finish");
}

describe("ScorecardService.ingestPull", () => {
  it("pulls traces from a trace source, derives metrics, and stores as succeeded", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    const trace: TraceEvent[] = [
      { t: 0, kind: "llm_call", model: "m" },
      { t: 1, kind: "tool_call", id: "t1", name: "bash", args: {} },
    ];
    let captured: TraceSourceConfig | undefined;
    const buildTraceSource = (cfg: TraceSourceConfig): TraceSource => {
      captured = cfg;
      return { fetch: async () => trace };
    };

    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      buildTraceSource,
      secretsFor: async () => ({ OTEL_TOKEN: "Bearer secret-xyz" }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://jaeger:16686", authSecret: "OTEL_TOKEN" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    expect(created.status).toBe("queued");

    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(done.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]);
    expect(done.scorecard?.results[0]?.scores.some((s) => s.metric === "tool_calls")).toBe(true);
    // authSecret → SecretStore value → injected into the trace source as an Authorization: Bearer header
    expect(captured?.headers?.authorization).toBe("Bearer secret-xyz");
  });

  it("missing dataset → NotFoundError (404)", async () => {
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      buildTraceSource: () => ({ fetch: async () => [] }),
    });
    await expect(
      service.ingestPull({
        tenant: "acme",
        dataset: { id: "missing", version: "latest" },
        harness: { id: "h", version: "1.0.0" },
        source: { kind: "otel", endpoint: "http://j" },
        runs: [{ caseId: "c1", runId: "r1" }],
        judges: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("buildTraceSource unset → the run ends failed (BAD_REQUEST)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({ dispatcher, store, datasets });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://j" },
      runs: [{ caseId: "c1", runId: "r1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BAD_REQUEST");
  });
});

describe("ScorecardService.submit — private-repo repoToken injection (per case)", () => {
  it("case env.source.connectionId → repoTokenFor resolve → per-case job.repoToken; public/non-git are not injected", async () => {
    const seen: Array<{ caseId: string; repoToken?: string }> = [];
    const cap: Dispatcher = {
      async dispatch(job) {
        seen.push({ caseId: job.evalCase.id, ...(job.repoToken !== undefined ? { repoToken: job.repoToken } : {}) });
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "priv",
      version: "1.0.0",
      tags: [],
      cases: [
        {
          id: "git-priv",
          env: { kind: "repo", source: { git: "https://github.com/acme/p.git", ref: "main", connectionId: "conn-1" } },
          task: "t",
          graders: [],
          timeoutSec: 60,
          tags: [],
        },
        {
          id: "files-pub",
          env: { kind: "repo", source: { files: {} } },
          task: "t",
          graders: [],
          timeoutSec: 60,
          tags: [],
        },
      ],
    });
    const store = new InMemoryScorecardStore();
    // Connections are personally owned → repoTokenFor resolves by owner (submitter subject).
    const calls: Array<{ owner: string; connectionId: string }> = [];
    const service = new ScorecardService({
      dispatcher: cap,
      store,
      datasets,
      newId: () => "sc-priv",
      repoTokenFor: async (owner, connectionId) => {
        calls.push({ owner, connectionId });
        return connectionId === "conn-1" ? "gho_sc" : undefined;
      },
    });
    await service.submit({
      tenant: "acme",
      submittedBy: "u-alice",
      dataset: { id: "priv", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-priv");
    const byCase = Object.fromEntries(seen.map((s) => [s.caseId, s.repoToken]));
    expect(byCase["git-priv"]).toBe("gho_sc");
    expect(byCase["files-pub"]).toBeUndefined();
    expect(calls).toEqual([{ owner: "u-alice", connectionId: "conn-1" }]); // the files case does not call the resolver
  });

  it("failure after dispatch (judges phase) → status=failed + error.phase=judges + partial results preserved (visibility)", async () => {
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j1",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "ok?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run() {
          throw new Error("judge boom");
        },
      },
      newId: () => "sc-phase",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    const rec = await waitTerminal(store, "sc-phase");
    expect(rec.status).toBe("failed");
    expect(rec.error?.phase).toBe("judges"); // "which phase" — judges-phase failure
    expect(rec.error?.message).toContain("judge boom"); // "how" — the reason
    // Partial results preserved: cases gathered up to dispatch remain in the failed record for visibility.
    expect(rec.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]);
    // Progress (step) timeline — case completion + judges-phase failure are recorded in order.
    expect(rec.steps?.some((s) => s.phase === "case" && s.caseId === "c1")).toBe(true);
    expect(rec.steps?.some((s) => s.phase === "judges" && s.status === "failed")).toBe(true);
  });

  it("judge is streaming — applied the moment a case completes rather than waiting for the whole batch (a barrier would hang this test)", async () => {
    // rendezvous: c2 dispatch blocks until c1's judge starts — if the judge were a post-batch barrier, they'd never meet.
    let judgeStarted: () => void = () => {};
    const c1Judged = new Promise<void>((resolve) => {
      judgeStarted = resolve;
    });
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "c2") await c1Judged; // a slow case that doesn't complete until c1's judge starts
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    const twoCase = datasetWithCase();
    const c1 = twoCase.cases[0];
    if (!c1) throw new Error("datasetWithCase guarantees one case");
    await datasets.register("acme", { ...twoCase, cases: [c1, { ...c1, id: "c2" }] });
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j1",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "ok?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run(spec) {
          judgeStarted(); // reached right after c1 completes (streaming) → c2 is released
          return { graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true };
        },
      },
      newId: () => "sc-stream",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    const rec = await waitTerminal(store, "sc-stream");
    expect(rec.status).toBe("succeeded");
    // Both cases get a judge score attached.
    for (const r of rec.scorecard?.results ?? []) {
      expect(r.scores.some((s) => s.metric === "judge:j1")).toBe(true);
    }
  }, 5000);

  it("on completion, calls the onComplete callback with the latest record (notification hook)", async () => {
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const seen: Array<{ tenant: string; status: string; id: string }> = [];
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-done",
      onComplete: async (tenant, rec) => {
        seen.push({ tenant, status: rec.status, id: rec.id });
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-done");
    expect(seen).toEqual([{ tenant: "acme", status: "succeeded", id: "sc-done" }]);
  });
});

describe("ScorecardService — trace sink export", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
      };
    },
  };

  it("sink export is case-streaming (D5) — fires the moment a case completes (a post-batch bulk export would hang this test)", async () => {
    // rendezvous: c2 dispatch waits for c1's export push — if export were post-batch bulk, they'd never meet.
    let c1Exported: () => void = () => {};
    const exportedC1 = new Promise<void>((resolve) => {
      c1Exported = resolve;
    });
    const gatedDispatch: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "c2") await exportedC1;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    const one = datasetWithCase();
    const c1 = one.cases[0];
    if (!c1) throw new Error("datasetWithCase guarantees one case");
    await datasets.register("acme", { ...one, cases: [c1, { ...c1, id: "c2" }] });
    const store = new InMemoryScorecardStore();
    const pushed: string[] = [];
    const exportStreamFor = async (): Promise<CaseExportStream> => ({
      push: (r) => {
        pushed.push(r.caseId);
        if (r.caseId === "c1") c1Exported(); // the instant c1 goes out, c2 is released (proves streaming)
      },
      settle: async () => ({
        sink: "mlflow",
        name: "mlf",
        status: "succeeded",
        exportedAt: "2026-07-07T00:00:00.000Z",
        cases: pushed.map((caseId) => ({ caseId, externalId: `ext-${caseId}` })),
      }),
    });
    const service = new ScorecardService({
      dispatcher: gatedDispatch,
      store,
      datasets,
      exportStreamFor,
      newId: () => "sc-export-stream",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const rec = await waitTerminal(store, "sc-export-stream");
    expect(rec.status).toBe("succeeded");
    expect(pushed).toEqual(["c1", "c2"]); // fired per case in completion order
    expect(rec.export?.cases?.map((c) => c.caseId)).toEqual(["c1", "c2"]); // settle aggregation lands in record.export
    expect(rec.steps?.some((s) => s.phase === "export" && s.status === "ok")).toBe(true);
  }, 5000);

  it("live batch: after scoring, the exportResults outcome is recorded in record.export and steps(export)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const calls: Array<{ ctx: { scorecardId: string; dataset: string; harness: string }; caseIds: string[] }> = [];
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-export",
      exportResults: async (_tenant, ctx, results) => {
        calls.push({ ctx, caseIds: results.map((r) => r.caseId) });
        return {
          sink: "mlflow",
          status: "succeeded",
          url: "http://mlflow/#/experiments/7",
          exportedAt: "2026-07-06T00:00:00.000Z",
          cases: [{ caseId: "c1", externalId: "tr-1", url: "http://mlflow/#/experiments/7?tr=tr-1" }],
        };
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done = await waitTerminal(store, "sc-export");
    // Then: the scored results go to export and the outcome remains in the record.
    expect(calls[0]?.ctx).toEqual({ scorecardId: "sc-export", dataset: "d@1.0.0", harness: "h@1" });
    expect(calls[0]?.caseIds).toEqual(["c1"]);
    expect(done.status).toBe("succeeded");
    expect(done.export?.status).toBe("succeeded");
    expect(done.export?.cases?.[0]?.externalId).toBe("tr-1");
    expect(done.steps?.some((s) => s.phase === "export" && s.status === "ok")).toBe(true);
  });

  it("even on export failure (outcome=failed·throw), the scorecard is succeeded — isolation principle", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    // the case recorded as outcome=failed.
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-exf",
      exportResults: async () => ({
        sink: "langfuse",
        status: "failed",
        message: "upstream 401",
        exportedAt: "2026-07-06T00:00:00.000Z",
      }),
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done = await waitTerminal(store, "sc-exf");
    expect(done.status).toBe("succeeded"); // export failure does not affect the result
    expect(done.error).toBeUndefined(); // error.phase unused
    expect(done.export?.status).toBe("failed");
    expect(done.steps?.some((s) => s.phase === "export" && s.status === "failed")).toBe(true);

    // Even if the hook itself throws (contract violation), the scorecard succeeds and only export is left unrecorded.
    const store2 = new InMemoryScorecardStore();
    const service2 = new ScorecardService({
      dispatcher: okDispatch,
      store: store2,
      datasets,
      newId: () => "sc-exth",
      exportResults: async () => {
        throw new Error("contract-violation throw");
      },
    });
    await service2.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done2 = await waitTerminal(store2, "sc-exth");
    expect(done2.status).toBe("succeeded");
    expect(done2.export).toBeUndefined();
  });

  it("pull ingest: the (source.kind, caseId→runId) attach hint is passed to export and the outcome is recorded", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    let attachSeen: { sourceKind: string; externalIdByCase: Record<string, string> } | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      buildTraceSource: () => ({ fetch: async () => [{ t: 0, kind: "llm_call", model: "m" }] }),
      exportResults: async (_tenant, _ctx, _results, attach) => {
        attachSeen = attach;
        return {
          sink: "mlflow",
          status: "succeeded",
          exportedAt: "2026-07-06T00:00:00.000Z",
          cases: [{ caseId: "c1", externalId: "tr-orig-1" }],
        };
      },
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow:5000" },
      runs: [{ caseId: "c1", runId: "tr-orig-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    // Then: the original trace coordinates flow through attach so scores can be attached to the existing trace (flow ②).
    expect(attachSeen).toEqual({ sourceKind: "mlflow", externalIdByCase: { c1: "tr-orig-1" } });
    expect(done.export?.cases?.[0]?.externalId).toBe("tr-orig-1");
  });
});

describe("ScorecardService.submit — leaderboard model-axis capture", () => {
  // A dispatcher that emits an llm_call(model) per case — the source of the observed model.
  const llmDispatch = (model: string): Dispatcher => ({
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
      };
    },
  });

  it("stores the trace-observed model as the succeeded record's models (observation first)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: llmDispatch("claude-opus-4-8"),
      store,
      datasets,
      newId: () => "sc-model",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-model");
    expect(rec.status).toBe("succeeded");
    expect(rec.models?.observed).toEqual(["claude-opus-4-8"]);
    expect(rec.models?.primary).toBe("claude-opus-4-8");
  });

  it("stores the inline judge-config model as the succeeded record's judgeModels (judge axis)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: llmDispatch("gpt-4o"),
      store,
      datasets,
      newId: () => "sc-judge",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judge: { provider: "openai", model: "gpt-5.4-mini" }, // grader
    });
    const rec = await waitTerminal(store, "sc-judge");
    expect(rec.status).toBe("succeeded");
    expect(rec.models?.primary).toBe("gpt-4o"); // the LLM the harness used
    expect(rec.judgeModels).toEqual(["gpt-5.4-mini"]); // grader — a separate axis
  });
});

describe("ScorecardService.submit — child-run fan-out (runStore)", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
      };
    },
  };

  it("with runStore set, creates a child run per case, hides them from the activity list, and references them via scorecard.runIds", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      runStore,
      datasets,
      newId: () => `sc-${n++}`, // sc-0 = scorecard, sc-1 = child run of case c1
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-0");
    expect(rec.status).toBe("succeeded");
    expect(rec.runIds).toEqual(["sc-1"]); // reference to the fanned-out child run
    expect(rec.scorecard).toBeUndefined(); // storage dedup — the heavy embed is not stored (runIds only)

    const child = await runStore.get("sc-1");
    expect(child?.status).toBe("succeeded");
    expect(child?.parentScorecardId).toBe("sc-0");
    expect(child?.trigger).toBe("scorecard");
    expect(child?.caseId).toBe("c1");

    // get hydrates the scorecard from child runs — the response shape is identical to the embed era (web/diff unchanged).
    const hydrated = await service.get("sc-0");
    expect(hydrated?.scorecard?.results).toHaveLength(1);
    expect(hydrated?.scorecard?.results[0]?.caseId).toBe("c1");
    // Write-back preserves case scores (grader/judge/metric) on the child → they come back intact on hydrate.
    expect(hydrated?.scorecard?.results[0]?.scores[0]?.metric).toBe("tests_pass");

    // The activity list (default) hides children, but by scorecardId those batch children are visible.
    expect(await runStore.list("acme")).toEqual([]);
    expect((await runStore.list("acme", { scorecardId: "sc-0" })).map((r) => r.id)).toEqual(["sc-1"]);
  });

  it("diff hydrates dedup (runIds) scorecards too and computes regression/improvement", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    // A dispatcher that flips pass — base passes, candidate fails (regression).
    const dispatchPass = (pass: boolean): Dispatcher => ({
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
        };
      },
    });
    // Per-service independent counters — base scorecard=b-0 (+child b-1), candidate scorecard=c-0 (+child c-1).
    let bn = 0;
    let cn = 0;
    const base = new ScorecardService({
      dispatcher: dispatchPass(true),
      store,
      runStore,
      datasets,
      newId: () => `b-${bn++}`,
    });
    await base.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "s", version: "0" } });
    await waitTerminal(store, "b-0");
    const cand = new ScorecardService({
      dispatcher: dispatchPass(false),
      store,
      runStore,
      datasets,
      newId: () => `c-${cn++}`,
    });
    await cand.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "s", version: "0" } });
    await waitTerminal(store, "c-0");

    // Both scorecards stored only runIds without embed, yet diff hydrates and catches the pass→fail regression.
    const diff = await base.diff("acme", "b-0", "c-0");
    expect(diff.regressions).toContainEqual({
      caseId: "c1",
      metric: "tests-pass",
      baseline: 1,
      candidate: 0,
      delta: -1,
      passChange: "broke",
    });
  });

  it("without runStore, embed the scorecard with no child runs (unchanged)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, newId: () => "sc-x" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-x");
    expect(rec.status).toBe("succeeded");
    expect(rec.runIds).toBeUndefined();
    expect(rec.scorecard?.results).toHaveLength(1); // embedded results are intact
  });
});

describe("ScorecardService.submit — request concurrency flows into runSuite parallelism", () => {
  // A dispatcher that measures concurrent in-flight dispatches — each dispatch must delay briefly for parallelism to build up.
  function probe(): { dispatcher: Dispatcher; peak: () => number } {
    let inFlight = 0;
    let max = 0;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    return { dispatcher, peak: () => max };
  }

  // A dataset of N cases (for parallelism testing — meaningful only when cases outnumber the concurrency).
  async function datasetN(datasets: InMemoryDatasetRegistry, n: number): Promise<void> {
    await datasets.register("acme", {
      id: "many",
      version: "1.0.0",
      tags: [],
      cases: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        env: { kind: "repo", source: { files: {} } } as const,
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });
  }

  it("request concurrency=3 → dispatches up to 3 at once (overrides the service default)", async () => {
    const { dispatcher, peak } = probe();
    const datasets = new InMemoryDatasetRegistry();
    await datasetN(datasets, 6);
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, concurrency: 1, newId: () => "sc-conc" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "many", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      concurrency: 3,
    });
    const done = await waitTerminal(store, "sc-conc");
    expect(done.status).toBe("succeeded");
    expect(peak()).toBe(3); // the request value (3) applied, not the service default (1)
  });

  it("request concurrency unset → serial dispatch at the service default concurrency (=1)", async () => {
    const { dispatcher, peak } = probe();
    const datasets = new InMemoryDatasetRegistry();
    await datasetN(datasets, 4);
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, concurrency: 1, newId: () => "sc-def" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "many", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-def");
    expect(peak()).toBe(1);
  });
});

describe("ScorecardService.submit — submit-time ephemeral pins + origin provenance", () => {
  const topoTemplate: HarnessTemplateSpec = {
    kind: "service",
    category: "topology",
    id: "bu",
    version: "1",
    services: [
      { name: "planner", needs: [], perRun: [], replicas: 1, env: {} },
      { name: "browser", needs: [], perRun: [], replicas: 1, env: {} },
    ],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  };
  const pinDataset: Dataset = {
    id: "pd",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };

  async function fixtures() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", pinDataset);
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", topoTemplate);
    await instances.register("acme", {
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "1.0.0",
      pins: { planner: "p:1", browser: "b:1" },
    });
    return { datasets, instances };
  }

  it("pins swap only the matching slot image in the dispatched harnessSpec and are recorded via origin.pinOverrides (registry unchanged)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const jobs: AgentJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return caseResult(true);
      },
    };
    const service = new ScorecardService({
      dispatcher: capture,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-pins",
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest", pins: { planner: "p:pr-7" } },
      origin: { source: "github-actions", repo: "acme/app", prNumber: 7 },
    });
    expect(rec.harness).toEqual({ id: "bu", version: "1.0.0" }); // ephemeral pins don't create a version (the base version is recorded)
    expect(rec.origin).toMatchObject({
      source: "github-actions",
      repo: "acme/app",
      prNumber: 7,
      pinOverrides: { planner: "p:pr-7" }, // reproducibility record of what was evaluated
    });
    await waitTerminal(store, "sc-pins");
    const spec = jobs[0]?.harnessSpec;
    if (spec?.kind !== "service") throw new Error("expected service harnessSpec");
    expect(spec.services.map((s) => s.image)).toEqual(["p:pr-7", "b:1"]); // only planner swapped
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]); // registry unchanged
  });

  it("unknown slot pin → BadRequest (prevents silently passing while ignoring the pin — no fallback)", async () => {
    const { datasets, instances } = await fixtures();
    const service = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      harnesses: instances,
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "pd", version: "latest" },
        harness: { id: "bu", version: "latest", pins: { nope: "x" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("no registry + pins → BadRequest (can't pin a built-in harness)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", pinDataset);
    const service = new ScorecardService({ dispatcher, store: new InMemoryScorecardStore(), datasets });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "pd", version: "latest" },
        harness: { id: "scripted", version: "0", pins: { image: "x" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("origin is recorded as-is even without pins (common provenance for schedule/web/api)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-origin",
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest" },
      origin: { source: "schedule" },
    });
    expect(rec.origin).toEqual({ source: "schedule" });
  });

  it("submittedBy (submitter) is stamped as the record's createdBy — the actor (who) paired with origin (where)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-by",
    });
    const rec = await service.submit({
      tenant: "acme",
      submittedBy: "user-alice",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest" },
    });
    expect(rec.createdBy).toBe("user-alice");
    expect((await store.get("sc-by"))?.createdBy).toBe("user-alice");
  });

  it("ingest (trace upload) also stamps submittedBy as createdBy", async () => {
    const { datasets } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, newId: () => "sc-ingest-by" });
    const rec = await service.ingest({
      tenant: "acme",
      submittedBy: "user-bob",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "1.0.0" },
      traces: [{ caseId: "c1", trace: [] }],
      judges: [],
    });
    expect(rec.createdBy).toBe("user-bob");
  });
});

describe("ScorecardService.submit — server-side supersede (re-firing the same PR reclaims the in-flight batch)", () => {
  const twoCaseDataset: Dataset = {
    id: "sd",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };
  // A gating dispatcher — records the moment of firing and holds the result until release() (to keep the batch "running").
  function gatedDispatcher() {
    const dispatched: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        dispatched.push(job.evalCase.id);
        await gate;
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, dispatched, release: () => release() };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("re-firing the same (repo,PR,harness,dataset) → the previous batch is superseded (remaining cases unfired · partial results preserved · notification skipped)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset);
    const gate = gatedDispatcher();
    const completions: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      concurrency: 1, // serial — while c1 is stuck at the gate, c2 stays unfired
      newId: () => `sup-${n++}`,
      onComplete: async (_tenant, rec) => {
        completions.push(rec.id);
      },
    });
    const base = {
      tenant: "acme",
      dataset: { id: "sd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    };
    const origin = { source: "github-actions", repo: "acme/app", prNumber: 7 };

    const first = await service.submit({ ...base, origin: { ...origin, sha: "old" } });
    await until(() => gate.dispatched.length === 1); // c1 fired (blocked at the gate)

    const second = await service.submit({ ...base, origin: { ...origin, sha: "new" } });
    // The previous batch is reclaimed immediately at submit time (before the 202 response — supersede is awaited inside submit).
    const supersededNow = await store.get(first.id);
    expect(supersededNow?.status).toBe("superseded");
    expect(supersededNow?.error?.code).toBe("SUPERSEDED");

    gate.release();
    await until(async () => (await store.get(second.id))?.status === "succeeded");
    await until(async () => (await store.get(first.id))?.scorecard !== undefined); // wait for the first batch to settle

    const finalFirst = await store.get(first.id);
    expect(finalFirst?.status).toBe("superseded"); // track settlement does not revive it to succeeded
    expect(finalFirst?.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]); // partial results (only what fired) preserved
    // The remaining case (c2) never fired in the first batch — total firings = first-batch c1 + second-batch c1,c2.
    expect(gate.dispatched).toHaveLength(3);
    expect(completions).toEqual([second.id]); // the superseded batch skips its completion notification
  });

  it("firings with no prNumber (merge/dev) or a different PR number do not supersede", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset);
    const gate = gatedDispatcher();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      concurrency: 2,
      newId: () => `keep-${n++}`,
    });
    const base = {
      tenant: "acme",
      dataset: { id: "sd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    };
    const pr7 = await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app", prNumber: 7 } });
    await until(() => gate.dispatched.length >= 1);
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app" } }); // merge — no prNumber
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app", prNumber: 8 } }); // a different PR
    expect((await store.get(pr7.id))?.status).toBe("running"); // not reclaimed
    gate.release();
    await until(async () => (await store.get(pr7.id))?.status === "succeeded"); // completes normally
  });
});

describe("ScorecardService.submit — partial run (subset)", () => {
  const threeCaseDataset = (): Dataset => ({
    id: "big",
    version: "1.0.0",
    cases: (["a", "b", "c"] as const).map((id, i) => ({
      id,
      env: { kind: "prompt" },
      task: `q-${id}`,
      graders: [],
      timeoutSec: 60,
      tags: i < 2 ? ["easy"] : ["hard"],
    })),
    tags: [],
  });
  const capture = () => {
    const dispatched: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        dispatched.push(job.evalCase.id);
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "prompt", output: "" },
          scores: [],
        };
      },
    };
    return { dispatched, dispatcher };
  };
  const build = async (id: string) => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset());
    const store = new InMemoryScorecardStore();
    const { dispatched, dispatcher } = capture();
    const service = new ScorecardService({ dispatcher, store, datasets, newId: () => id });
    return { datasets, store, dispatched, service };
  };
  const submitBase = {
    tenant: "acme",
    dataset: { id: "big", version: "1.0.0" },
    harness: { id: "scripted", version: "0" },
  };

  it("with limit, only the first N run and record.subset is stamped", async () => {
    const { store, dispatched, service } = await build("sc-lim");
    const rec = await service.submit({ ...submitBase, cases: { limit: 2 } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, limit: 2 });
    await waitTerminal(store, "sc-lim");
    expect([...dispatched].sort()).toEqual(["a", "b"]);
    expect((await store.get("sc-lim"))?.scorecard?.results).toHaveLength(2);
  });

  it("tags is an any-match filter (combined with limit)", async () => {
    const { store, dispatched, service } = await build("sc-tag");
    const rec = await service.submit({ ...submitBase, cases: { tags: ["easy"], limit: 1 } });
    expect(rec.subset).toEqual({ total: 3, selected: 1, tags: ["easy"], limit: 1 });
    await waitTerminal(store, "sc-tag");
    expect(dispatched).toEqual(["a"]);
  });

  it("ids is explicit selection — an unknown id is rejected immediately with 400 (no silent partial run)", async () => {
    const { store, dispatched, service } = await build("sc-ids");
    const rec = await service.submit({ ...submitBase, cases: { ids: ["c", "a"] } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, ids: ["c", "a"] });
    await waitTerminal(store, "sc-ids");
    expect([...dispatched].sort()).toEqual(["a", "c"]);
    await expect(service.submit({ ...submitBase, cases: { ids: ["a", "nope"] } })).rejects.toThrow(/nope/);
  });

  it("zero selected → 400 (tag mismatch)", async () => {
    const { service } = await build("sc-empty");
    await expect(service.submit({ ...submitBase, cases: { tags: ["no-such-tag"] } })).rejects.toThrow(
      /No cases match the selection/,
    );
  });

  it("unset cases runs everything + no subset stamp (unchanged)", async () => {
    const { store, dispatched, service } = await build("sc-all");
    const rec = await service.submit({ ...submitBase });
    expect(rec.subset).toBeUndefined();
    await waitTerminal(store, "sc-all");
    expect(dispatched).toHaveLength(3);
  });
});

// Batch resilience — restart resume + retry-failed + persisted orchestration (docs/architecture/batch-resilience.md).
describe("ScorecardService — batch resilience (resume · retry-failed)", () => {
  const threeCaseDataset: Dataset = {
    id: "rd",
    version: "1.0.0",
    cases: (["c1", "c2", "c3"] as const).map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
    tags: [],
  };
  const passResult = (caseId: string, pass = true): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
  });
  function capturingDispatcher() {
    const dispatched: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        dispatched.push(job.evalCase.id);
        return passResult(job.evalCase.id);
      },
    };
    return { dispatched, dispatcher };
  }
  function build(dispatcher: Dispatcher) {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `id-${n++}`,
    });
    return { store, runs, datasets, service };
  }

  it("submit persists the orchestration inputs (judges/judge/concurrency/retries) needed to re-drive the batch", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      judge: { model: "gpt-5.4-mini" },
      concurrency: 7,
      retries: 2,
    });
    expect(rec.orchestration).toEqual({
      judges: [],
      judge: { model: "gpt-5.4-mini" },
      concurrency: 7,
      retries: 2,
    });
    await waitTerminal(store, rec.id);
  });

  it("resume keeps the finished children and re-dispatches only the unfinished cases", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, runs, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    // An interrupted batch: c1 finished (child with result), c2 was mid-flight when the process died, c3 never started.
    await store.create({
      id: "sc-int",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      orchestration: { judges: [], concurrency: 2, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: passResult("c1"),
      parentScorecardId: "sc-int",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });
    await runs.create({
      id: "child-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "running",
      parentScorecardId: "sc-int",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:01.000Z",
    });

    expect(await service.resume("sc-int")).toBe(true);
    const rec = await waitTerminal(store, "sc-int");

    expect(dispatched.sort()).toEqual(["c2", "c3"]); // c1 is never re-run
    expect(rec.status).toBe("succeeded");
    // Full case set in the final aggregate — the carried result plus the two re-runs.
    const hydrated = await service.get("sc-int");
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]);
    expect(rec.runIds).toContain("child-c1"); // the seed child stays addressable
    expect(rec.steps?.some((s) => s.phase === "resume")).toBe(true);
    // The mid-flight child was superseded by the re-dispatch.
    expect((await runs.get("child-c2"))?.status).toBe("failed");
    expect((await runs.get("child-c2"))?.error?.code).toBe("INTERRUPTED");
  });

  it("resume refuses records it cannot faithfully re-drive (terminal status / no orchestration)", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, service, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-done",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 1, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await store.create({
      id: "sc-legacy",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running", // interrupted, but a pre-orchestration record
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(await service.resume("sc-done")).toBe(false);
    expect(await service.resume("sc-legacy")).toBe(false);
  });

  it("retryFailed re-runs only the failed cases into a NEW scorecard and carries the passes verbatim", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-src",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), passResult("c2", false), passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-src", submittedBy: "alice" });
    expect(rec.origin?.retryOf).toBe("sc-src");
    expect(rec.createdBy).toBe("alice");
    const done = await waitTerminal(store, rec.id);

    expect(dispatched.sort()).toEqual(["c2", "c3"]); // only the failed cases re-run
    expect(done.status).toBe("succeeded");
    const hydrated = await service.get(rec.id);
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]);
    // The source record is untouched (history immutable).
    expect((await store.get("sc-src"))?.status).toBe("succeeded");
    expect((await store.get("sc-src"))?.scorecard?.results).toHaveLength(3);
  });

  it("retryFailed with failureClass=infra re-runs ONLY infra casualties — agent FAILs stay carried over", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const infraFailed: CaseResult = {
      ...passResult("c2", false),
      failure: {
        stage: "dispatch",
        class: "infra",
        code: "UPSTREAM_ERROR",
        message: "placement blip",
        retryable: true,
      },
    };
    await store.create({
      id: "sc-mixed",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        // c1 passes · c2 infra-failed · c3 legitimate agent FAIL (grader verdict, no failure field)
        results: [passResult("c1"), infraFailed, passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-mixed", failureClass: "infra" });
    await waitTerminal(store, rec.id);
    expect(dispatched).toEqual(["c2"]); // only the infra casualty re-runs
    const hydrated = await service.get(rec.id);
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]); // agent FAIL carried
    // Filter with no matches → 400 with a class-specific message.
    await expect(service.retryFailed({ tenant: "acme", id: "sc-mixed", failureClass: "config" })).rejects.toThrow(
      /config-class/,
    );
  });

  it("retryFailed rejects an in-flight source (400) and an all-pass source (nothing to retry)", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-running",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await store.create({
      id: "sc-clean",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      scorecard: { suiteId: "rd", harness: "h@1", results: [passResult("c1")] },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await expect(service.retryFailed({ tenant: "acme", id: "sc-running" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.retryFailed({ tenant: "acme", id: "sc-clean" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.retryFailed({ tenant: "beta", id: "sc-clean" })).rejects.toBeInstanceOf(NotFoundError); // other-workspace = 404
  });
});
