import type { Dispatcher } from "@everdict/backends";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  type Dataset,
  ForbiddenError,
  type HarnessTemplateSpec,
  type JudgeSpec,
  NotFoundError,
  type RunRecord,
  type Scorecard,
  type TraceEvent,
  UpstreamError,
} from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore, type ScorecardRecord } from "@everdict/db";
import { CircuitBreaker, type Principal, inMemoryUsageMeter } from "@everdict/domain";
import { costGrader, latencyGrader, stepsGrader } from "@everdict/graders";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@everdict/registry";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { describe, expect, it } from "vitest";

// Trace-only grader factory injected into the ingest path (re-architecture P2 S4) — the application layer never
// imports @everdict/graders, so the composition side supplies the steps/cost/latency graders the ingest re-derives.
const defaultTraceGraders = () => [stepsGrader, costGrader, latencyGrader];
import type { CaseExportStream } from "@everdict/application-control";
import { ScorecardService } from "@everdict/application-control";

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

// A harnesses port whose get() rejects — models a REGISTERED harness whose stored spec fails to resolve (a malformed
// target/delivery, a bad pin). Such a spec can't be created through the real registry (it validates on register), so
// the fake throws directly. Extends the in-memory impl to satisfy the whole port with a one-method override.
class ThrowingHarnessRegistry extends InMemoryHarnessInstanceRegistry {
  constructor(private readonly err: Error) {
    super(new InMemoryHarnessTemplateRegistry());
  }
  override get() {
    return Promise.reject(this.err);
  }
}

describe("ScorecardService.submit — registered harness spec resolution (regression)", () => {
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

  it("a registered harness whose spec fails to resolve → 400 (BadRequest), not a silent spec-less dispatch", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: new ThrowingHarnessRegistry(
        new BadRequestError("BAD_REQUEST", {}, "Invalid discriminator value at target.delivery.mode."),
      ),
      newId: () => "sc-badspec",
    });
    // Pre-fix: the resolve error was swallowed (treated as built-in), the batch ran with NO spec embedded, no error.
    await expect(
      service.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "svc", version: "1" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await store.get("sc-badspec")).toBeUndefined(); // failed fast — before a queued record was even persisted
  });

  it("a raw (non-AppError) resolve failure is remapped into our error model (never propagated bare)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      harnesses: new ThrowingHarnessRegistry(
        new Error("Invalid discriminator value. Expected 'reference' | 'sentinel' | 'egress'"),
      ),
      newId: () => "sc-raw",
    });
    await expect(
      service.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "svc", version: "1" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("an unregistered/built-in harness (NotFound) still dispatches as-given, no spec embedded", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      harnesses: new ThrowingHarnessRegistry(new NotFoundError("NOT_FOUND", {}, "harness 'scripted' not found.")),
      newId: () => "sc-builtin",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-builtin");
    expect(rec.status).toBe("succeeded"); // NotFound stays swallowed — the built-in fall-through is preserved
  });
});

describe("ScorecardService.submit — judge version pinning (reproducibility)", () => {
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
  const modelJudge = (version: string): JudgeSpec => ({
    kind: "model",
    id: "quality",
    version,
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric: "good?",
    inputs: ["trace"],
    tags: [],
  });

  it("resolves a selected judge's 'latest' to the concrete version and records it — a re-run scores with the SAME judge", async () => {
    // Regression: orchestration.judges used to store the ref as-given, so a later re-run/schedule resolved "latest"
    // again → possibly a different judge version → a different verdict. Harness/dataset were pinned; judges were not.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", modelJudge("1.0.0"));
    await judges.register("acme", modelJudge("2.0.0")); // latest
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, judges, newId: () => "sc-pin" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "quality", version: "latest" }],
    });
    const rec = await waitTerminal(store, "sc-pin");
    expect(rec.orchestration?.judges).toEqual([{ id: "quality", version: "2.0.0" }]); // concrete, never "latest"
  });

  it("keeps an unknown judge id as-given (the scoring path skips a missing judge, unchanged)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges: new InMemoryJudgeRegistry(),
      newId: () => "sc-unknown",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "ghost", version: "latest" }],
    });
    const rec = await waitTerminal(store, "sc-unknown");
    expect(rec.orchestration?.judges).toEqual([{ id: "ghost", version: "latest" }]); // kept as-given
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

  // N trials of case c1, the first `passes` passing.
  const trialCard = (harness: string, passes: number, n: number): Scorecard => ({
    suiteId: "d",
    harness,
    results: Array.from(
      { length: n },
      (_, i): CaseResult => ({
        caseId: "c1",
        harness,
        trial: i,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: i < passes ? 1 : 0, pass: i < passes }],
      }),
    ),
  });

  it("attaches a statistically-gated trial diff — a significant pass-rate collapse (5/5 → 0/5) is a regression", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: trialCard("h@1", 5, 5) }));
    await store.create(record("cand", { scorecard: trialCard("h@2", 0, 5) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials?.regressions.map((r) => r.caseId)).toEqual(["c1"]);
    expect(diff.trials?.cases[0]?.significant).toBe(true);
  });

  it("a within-noise trial drop (3/5 → 2/5) is NOT flagged as a trial regression", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: trialCard("h@1", 3, 5) }));
    await store.create(record("cand", { scorecard: trialCard("h@2", 2, 5) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials?.regressions).toEqual([]);
    expect(diff.trials?.cases[0]?.significant).toBe(false);
  });

  it("a single-run diff carries no trials field (backward compatible)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials).toBeUndefined();
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

describe("ScorecardService.rerun — full re-run of a finished batch (전체 재실행)", () => {
  // Dispatch returns a scored result so the background track settles cleanly (the assertions read the
  // synchronously-created new record either way).
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

  // A finished source batch whose config the re-run must reproduce — a CI-triggered PR run (repo/prNumber origin),
  // a subset, a selected judge, and a grading plan.
  const seedSrc = async (store: InMemoryScorecardStore, over: Partial<ScorecardRecord> = {}) => {
    const src = record("src-1", {
      status: "succeeded",
      runtime: "self:laptop",
      origin: { source: "github-actions", repo: "acme/app", prNumber: 7 },
      subset: { total: 3, selected: 1, ids: ["c1"] },
      orchestration: {
        judges: [{ id: "j", version: "1" }],
        concurrency: 2,
        retries: 1,
        graders: [{ id: "tests-pass" }],
      },
      ...over,
    });
    await store.create(src);
    return src;
  };

  const build = (store: InMemoryScorecardStore) => {
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, newId: () => `new-${n++}` });
    return { datasets, service };
  };

  it("clones the record's config into a NEW scorecard (retryOf lineage) and does NOT inherit the PR — so a manual re-run never supersedes the PR's in-flight batches", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store);
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    const created = await service.rerun({ tenant: "acme", id: "src-1", submittedBy: "alice" });

    expect(created.id).toBe("new-0"); // a fresh record, not a mutation of the source
    expect(created.origin?.retryOf).toBe("src-1"); // lineage kept
    expect(created.origin?.repo).toBeUndefined(); // PR provenance deliberately dropped …
    expect(created.origin?.prNumber).toBeUndefined(); // … so submit's PR-supersede never fires for a manual re-run
    // Config reproduced faithfully.
    expect(created.dataset).toEqual({ id: "d", version: "1.0.0" });
    expect(created.runtime).toBe("self:laptop");
    expect(created.subset?.ids).toEqual(["c1"]);
    expect(created.orchestration?.judges).toEqual([{ id: "j", version: "1" }]);
    expect(created.orchestration?.concurrency).toBe(2);
    expect(created.orchestration?.graders).toEqual([{ id: "tests-pass" }]); // original grading plan inherited
    expect(created.createdBy).toBe("alice");
    // The source record is never mutated.
    expect((await store.get("src-1"))?.status).toBe("succeeded");
  });

  it("applies re-score overrides (grading plan / judge model / trace sink) to the new batch's orchestration", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store);
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    const created = await service.rerun({
      tenant: "acme",
      id: "src-1",
      graders: [{ id: "cost" }],
      judgeModel: "gpt-x",
      traceSink: "none",
    });

    expect(created.orchestration?.graders).toEqual([{ id: "cost" }]); // override replaces the inherited plan
    expect(created.orchestration?.judge).toEqual({ model: "gpt-x" });
    expect(created.orchestration?.traceSink).toBe("none");
  });

  it("rejects re-running a batch that has not finished (400) and hides another workspace's / a missing scorecard (404)", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store, { status: "running" });
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    await expect(service.rerun({ tenant: "acme", id: "src-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.rerun({ tenant: "acme", id: "missing" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.rerun({ tenant: "other", id: "src-1" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

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
      defaultTraceGraders,
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

  it("resolves a REGISTERED source referenced by name (register once, pull by name) — the credential comes from the pool, not the request", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const trace: TraceEvent[] = [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: {} }];
    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async () => trace };
      },
      // the workspace pool resolver — a name → the whole config (as TraceSourceService.resolveByName does).
      resolveTraceSourceByName: async (_t, name) => {
        if (name !== "prod-mlflow") throw new BadRequestError("BAD_REQUEST", {}, "Unregistered trace source");
        return {
          kind: "mlflow",
          endpoint: "https://mlflow.prod",
          headers: { authorization: "Basic xyz" },
          project: "7",
          correlate: "tag",
        };
      },
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { name: "prod-mlflow" }, // just a name — no kind/endpoint/credential restated
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(captured).toMatchObject({ kind: "mlflow", endpoint: "https://mlflow.prod", project: "7" });
    expect(captured?.headers?.authorization).toBe("Basic xyz"); // resolved from the registered pool
  });

  it("applies the per-harness conversion overlay (spanMappingFor) to the pull-eval trace source", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async (): Promise<TraceEvent[]> => [{ t: 0, kind: "llm_call", model: "m" }] };
      },
      // The judge-wizard-authored overlay, keyed by the producing harness id — the periodic-eval consumer.
      spanMappingFor: async (_tenant, harnessId) => (harnessId === "h" ? { model: ["my.llm.model"] } : undefined),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://jaeger:16686" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    await waitTerminal(store, created.id);
    // The overlay flows through to the trace source so production traces normalize the harness/judge's way.
    expect(captured?.mapping).toEqual({ model: ["my.llm.model"] });
  });

  it("fetchDetailed evidence (dom/screenshot) synthesizes a browser snapshot the judges read", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      // The source extracts evidence slots (mapping-authored) alongside the events — the pull-path substitute
      // for the EnvSnapshot a live run produces.
      buildTraceSource: (): TraceSource => ({
        fetch: async () => [],
        fetchDetailed: async () => ({
          events: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
          evidence: {
            finalAnswer: "done",
            dom: "<html>goal</html>",
            screenshot: "QUJD",
            screenshotMediaType: "image/png",
            custom: { confirmation_id: "R-42" },
          },
        }),
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    const snapshot = done.scorecard?.results[0]?.snapshot;
    expect(snapshot?.kind).toBe("browser");
    if (snapshot?.kind === "browser") {
      expect(snapshot.dom).toBe("<html>goal</html>");
      expect(snapshot.screenshot).toBe("QUJD");
    }
    // the evidence itself rides the CaseResult — the carrier that brings CUSTOM slots to the judges
    expect(done.scorecard?.results[0]?.evidence?.custom).toEqual({ confirmation_id: "R-42" });
  });

  it("fetchDetailed without browser evidence keeps the synthetic ingest snapshot (no empty browser shell)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      buildTraceSource: (): TraceSource => ({
        fetch: async () => [],
        fetchDetailed: async () => ({ events: [{ t: 0, kind: "message", role: "assistant", text: "done" }] }),
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.scorecard?.results[0]?.snapshot.kind).toBe("repo");
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
          return [{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true }];
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
describe("ScorecardService — batch-on-Temporal internals (plan → case → finalize)", () => {
  const threeCases: Dataset = {
    id: "td",
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
  const ok = (caseId: string): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
  });
  function wire(dispatcher: Dispatcher) {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => `t-${n++}` });
    return { store, runs, datasets, service };
  }
  const record = () => ({
    id: "sc-t",
    tenant: "acme",
    dataset: { id: "td", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "queued" as const,
    runtime: "rt-a,rt-b",
    orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "everdict-batch-sc-t" },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  });

  it("the full workflow loop — plan lists remaining cases (sharded targets), each case settles once, finalize aggregates", async () => {
    const seen: Array<{ id: string; target?: string }> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        seen.push({
          id: job.evalCase.id,
          ...(job.evalCase.placement?.target ? { target: job.evalCase.placement.target } : {}),
        });
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create(record());

    const plan = await service.planBatch("sc-t");
    expect(plan).toEqual({ caseIds: ["c1", "c2", "c3"], concurrency: 2 });

    for (const cid of plan.caseIds) {
      expect(await service.runBatchCase("sc-t", cid)).toEqual({ settled: true });
    }
    // Idempotency — a retried activity for an already-settled case never re-dispatches.
    expect(await service.runBatchCase("sc-t", "c1")).toEqual({ settled: true, skipped: true });
    expect(seen.map((x) => x.id)).toEqual(["c1", "c2", "c3"]);
    // Sharding parity with the in-process loop: selected-index round-robin over the comma list.
    expect(seen.map((x) => x.target)).toEqual(["rt-a", "rt-b", "rt-a"]);

    await service.finalizeBatch("sc-t");
    const rec = await store.get("sc-t");
    expect(rec?.status).toBe("succeeded");
    expect(rec?.summary?.[0]).toMatchObject({ metric: "tests-pass", count: 3, passRate: 1 });
    const hydrated = await service.get("sc-t");
    expect(hydrated?.scorecard?.results.map((r) => r.caseId)).toEqual(["c1", "c2", "c3"]);
    expect(rec?.steps?.some((s) => s.phase === "dispatch" && s.message.includes("Temporal"))).toBe(true);
  });

  it("a re-plan after a restart returns only unfinished cases (done children excluded)", async () => {
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, runs, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create(record());
    await runs.create({
      id: "done-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "succeeded",
      result: ok("c2"),
      parentScorecardId: "sc-t",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });
    const plan = await service.planBatch("sc-t");
    expect(plan.caseIds).toEqual(["c1", "c3"]);
  });

  it("submit with a temporal driver stamps workflowId and starts the workflow; a failed start degrades to in-process", async () => {
    const started: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    const svc = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => "sc-wf",
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async (id) => {
          started.push(id);
        },
      },
    });
    const rec = await svc.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    expect(started).toEqual(["sc-wf"]);
    expect(rec.orchestration?.workflowId).toBe("everdict-batch-sc-wf");
    expect((await store.get("sc-wf"))?.status).toBe("queued"); // the workflow drives it — no in-process track

    // Failed start → fall back to the in-process loop (workflowId stripped, batch completes).
    let m = 0;
    const store2 = new InMemoryScorecardStore();
    const svc2 = new ScorecardService({
      dispatcher,
      store: store2,
      datasets,
      newId: () => `sc-fb-${m++}`,
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async () => {
          throw new Error("temporal down");
        },
      },
    });
    const rec2 = await svc2.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const final = await waitTerminal(store2, rec2.id);
    expect(final.status).toBe("succeeded");
    expect(final.orchestration?.workflowId).toBeUndefined();
  });

  it("boot resume leaves a Temporal-owned batch alone (returns handled without re-driving)", async () => {
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create({ ...record(), status: "running" });
    expect(await service.resume("sc-t")).toBe(true);
    expect((await store.get("sc-t"))?.status).toBe("running"); // untouched — the workflow owns it
  });
});

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

  it('runtime:"auto" expands to every registered runtime and shards; empty registry is a 400', async () => {
    const seen: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        seen.push(job.evalCase.placement?.target ?? "?");
        return passResult(job.evalCase.id);
      },
    };
    const { store, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const svc = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `auto-${n++}`,
      runtimesFor: async () => ["rt-x", "rt-y"],
    });
    const rec = await svc.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      runtime: "auto",
      concurrency: 1,
    });
    await waitTerminal(store, rec.id);
    expect(rec.runtime).toBe("rt-x,rt-y"); // the record shows the expansion
    expect(seen).toEqual(["rt-x", "rt-y", "rt-x"]);

    const empty = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      runtimesFor: async () => [],
    });
    await expect(
      empty.submit({
        tenant: "acme",
        dataset: { id: "rd", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        runtime: "auto",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("a comma-separated runtime SHARDS the batch — cases round-robin across the listed runtimes", async () => {
    const seen: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: AgentJob) {
        seen.push(job.evalCase.placement?.target ?? "?");
        return passResult(job.evalCase.id);
      },
    };
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      runtime: "nomad-a, k8s-b",
      concurrency: 1, // serial → deterministic round-robin order
    });
    await waitTerminal(store, rec.id);
    expect(seen).toEqual(["nomad-a", "k8s-b", "nomad-a"]);
    expect(rec.runtime).toBe("nomad-a, k8s-b"); // the record keeps the full sharding list
  });

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

  it("resume ADOPTS a still-alive backend job instead of re-dispatching (in-flight adoption)", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, runs, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const adoptedFor: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `ad-${n++}`,
      // The runtime still runs the job the dead control plane submitted — harvest it.
      adoptCase: async (_tenant, _runtime, caseId) => {
        adoptedFor.push(caseId);
        return caseId === "c2" ? passResult("c2") : undefined;
      },
    });
    await store.create({
      id: "sc-adopt",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      runtime: "nomad-local",
      orchestration: { judges: [], concurrency: 2, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "running", // mid-flight when the process died — but its Nomad job is still alive
      runtime: "nomad-local",
      parentScorecardId: "sc-adopt",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:01.000Z",
    });

    expect(await service.resume("sc-adopt")).toBe(true);
    const rec = await waitTerminal(store, "sc-adopt");

    expect(adoptedFor).toContain("c2");
    expect(dispatched.sort()).toEqual(["c1", "c3"]); // c2 was ADOPTED — never re-dispatched
    expect(rec.status).toBe("succeeded");
    const child = await runs.get("child-c2");
    expect(child?.status).toBe("succeeded"); // the same child settles with the harvested result (no INTERRUPTED)
    expect(child?.result?.caseId).toBe("c2");
    expect(rec.steps?.some((s) => s.phase === "resume" && s.message.includes("adopted"))).toBe(true);
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

  it("retryFailed re-COLLECTS a collect-stage failure by its traceRef — the agent is never re-dispatched", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const pulled: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `rc-${n++}`,
      // The platform is reachable again at retry time — the pull recovers the case.
      buildTraceSource: () => ({
        async fetch(runId: string) {
          pulled.push(runId);
          return [{ t: 1, kind: "llm_call" as const, model: "m" }];
        },
      }),
    });
    // c2 ran fine (ground-truth PASS) but its trace pull died — classified {collect} with re-collect coordinates.
    const collectFailed: CaseResult = {
      ...passResult("c2"),
      traceRef: { kind: "otel", endpoint: "http://collector:9", runId: "rid-c2" },
      failure: {
        stage: "collect",
        class: "infra",
        code: "TRACE_COLLECT_FAILED",
        message: "trace collection failed: fetch failed",
        retryable: true,
      },
    };
    await store.create({
      id: "sc-collect",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), collectFailed, passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-collect" });
    const done = await waitTerminal(store, rec.id);

    expect(done.status).toBe("succeeded");
    expect(pulled).toEqual(["rid-c2"]); // re-pulled by the frozen correlation key
    expect(dispatched.sort()).toEqual(["c3"]); // ONLY the genuine failure re-dispatched — c2 never re-ran
    const hydrated = await service.get(rec.id);
    const c2 = hydrated?.scorecard?.results.find((r) => r.caseId === "c2");
    expect(c2?.failure).toBeUndefined(); // recovered — classification shed
    expect(c2?.trace.some((e) => e.kind === "llm_call")).toBe(true); // the collected platform trace landed
    expect(c2?.scores.some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true); // ground truth kept
  });

  it("retryFailed doubles an OOM_KILLED case's memoryMb on the job only, and compounds across consecutive retries", async () => {
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", {
      kind: "command",
      category: "cli-agent",
      id: "oomb",
      version: "1",
      resources: { memoryMb: 64 },
      setup: [],
      command: "run",
      env: {},
      params: {},
      trace: { kind: "none" },
    });
    await instances.register("acme", {
      template: { id: "oomb", version: "1" },
      id: "oomb",
      version: "1.0.0",
      pins: {},
    });

    const oomResult = (caseId: string): CaseResult => ({
      ...passResult(caseId, false),
      failure: { stage: "dispatch", class: "infra", code: "OOM_KILLED", message: "task OOM-killed", retryable: false },
    });
    // The dispatcher keeps OOM-killing c2 — each retry must escalate from the PREVIOUS boost, not the spec base.
    const jobs: AgentJob[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return oomResult(job.evalCase.id);
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => `oom-${n++}`,
    });
    await store.create({
      id: "sc-oom",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "oomb", version: "1.0.0" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      scorecard: {
        suiteId: "rd",
        harness: "oomb@1.0.0",
        results: [passResult("c1"), oomResult("c2"), passResult("c3")],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const retry1 = await service.retryFailed({ tenant: "acme", id: "sc-oom" });
    await waitTerminal(store, retry1.id);
    expect(retry1.origin?.memoryBoostMb).toEqual({ c2: 128 }); // 64 → 128
    const job1 = jobs.find((j) => j.evalCase.id === "c2");
    expect(job1?.harnessSpec?.kind === "command" && job1.harnessSpec.resources?.memoryMb).toBe(128);

    // The retried case OOMed again → the next retry compounds from 128, not from the 64 spec base.
    jobs.length = 0;
    const retry2 = await service.retryFailed({ tenant: "acme", id: retry1.id });
    await waitTerminal(store, retry2.id);
    expect(retry2.origin?.memoryBoostMb).toEqual({ c2: 256 });
    const job2 = jobs.find((j) => j.evalCase.id === "c2");
    expect(job2?.harnessSpec?.kind === "command" && job2.harnessSpec.resources?.memoryMb).toBe(256);
    // The registry spec itself is untouched — the boost rides the job only.
    const spec = await instances.get("acme", "oomb", "1.0.0");
    expect(spec.kind === "command" && spec.resources?.memoryMb).toBe(64);
  });

  it("retryFailed with the Temporal driver: seeds materialize as child runs, the workflow is started, and planBatch sees only the failures", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    const started: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `tp-${n++}`,
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async (id) => {
          started.push(id);
        },
      },
    });
    await store.create({
      id: "sc-tp",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), passResult("c2", false), passResult("c3")],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-tp" });
    // The async branch stamps + starts — settle it.
    for (let i = 0; i < 50 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual([rec.id]); // the retry batch is workflow-owned
    const stamped = await store.get(rec.id);
    expect(stamped?.orchestration?.workflowId).toBe(`everdict-batch-${rec.id}`);
    expect(stamped?.steps?.some((s) => s.phase === "resume" && s.message.includes("Retry of sc-tp"))).toBe(true);
    // Seeds (c1, c3) materialized as succeeded children → the idempotent plan drives only the failure.
    const children = await runs.list("acme", { scorecardId: rec.id });
    expect(children.map((c) => c.caseId).sort()).toEqual(["c1", "c3"]);
    const plan = await service.planBatch(rec.id);
    expect(plan.caseIds).toEqual(["c2"]);
  });

  it("submit validates a per-batch traceSink against the workspace sinks and persists it on orchestration", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `sink-${n++}`,
      sinkExists: async (_t, name) => name === "mlf",
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "rd", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        traceSink: "ghost", // not configured → 400 at submit, before any dispatch
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      traceSink: "mlf",
    });
    expect(rec.orchestration?.traceSink).toBe("mlf"); // persisted — resume/retry keep the destination
    await waitTerminal(store, rec.id);

    // "none" never needs a configured sink — it means "suppress export for this batch".
    const none = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      traceSink: "none",
    });
    expect(none.orchestration?.traceSink).toBe("none");
    await waitTerminal(store, none.id);
  });

  it("estimate projects per-case medians from recent succeeded batches; no history = honest empty", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => `est-${n++}` });

    // No history yet — honest empty (a guess would be worse than nothing).
    expect(await service.estimate({ tenant: "acme", dataset: "rd", harness: "h" })).toEqual({
      basis: { scorecards: 0, samples: 0 },
    });

    // One past batch: 3 children, durations 10/20/30s, usd 0.01/0.02/0.03 → medians 20s / 0.02.
    await store.create({
      id: "sc-hist",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:10:00.000Z",
    });
    const mkChild = async (i: number, sec: number, usd: number) =>
      runs.create({
        id: `hist-${i}`,
        tenant: "acme",
        harness: { id: "h", version: "1" },
        caseId: `c${i}`,
        status: "succeeded",
        result: {
          caseId: `c${i}`,
          harness: "h@1",
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd } }],
          snapshot: { kind: "prompt", output: "" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        },
        parentScorecardId: "sc-hist",
        trigger: "scorecard",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: new Date(Date.parse("2026-07-08T00:00:00.000Z") + sec * 1000).toISOString(),
      });
    await mkChild(1, 10, 0.01);
    await mkChild(2, 20, 0.02);
    await mkChild(3, 30, 0.03);

    const est = await service.estimate({ tenant: "acme", dataset: "rd", harness: "h", cases: 100, concurrency: 10 });
    expect(est.basis).toEqual({ scorecards: 1, samples: 3 });
    expect(est.perCase).toEqual({ usdMedian: 0.02, durationSecMedian: 20 });
    // 100 cases × $0.02 = $2 · ceil(100/10) waves × 20s = 200s.
    expect(est.estimate).toEqual({ cases: 100, usd: 2, wallSeconds: 200, concurrency: 10 });
  });

  it("a running batch's get() carries etaSeconds derived from its own finished children", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => "eta-1" });
    await store.create({
      id: "sc-eta",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      orchestration: { judges: [], concurrency: 1, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    // one finished child took 30s → 2 remaining of 3 at concurrency 1 → ETA 60s.
    await runs.create({
      id: "eta-child",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: passResult("c1"),
      parentScorecardId: "sc-eta",
      trigger: "scorecard",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:30.000Z",
    });
    expect((await service.get("sc-eta"))?.etaSeconds).toBe(60);
    // terminal records never carry an ETA.
    await store.update("sc-eta", { status: "succeeded", updatedAt: "x" });
    expect((await service.get("sc-eta"))?.etaSeconds).toBeUndefined();
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

describe("ScorecardService.submit — N-trial (pass@k / flakiness)", () => {
  it("fans each case into N trials, creates a child run per trial, and derives a trialSummary on get()", async () => {
    // Given: a 1-case dataset and a dispatch where trial 1 fails (2/3 → flaky). job.trial reaches the dispatcher.
    const seenTrials: Array<number | undefined> = [];
    const trialDispatch: Dispatcher = {
      async dispatch(job) {
        seenTrials.push(job.trial);
        const pass = job.trial !== 1;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: trialDispatch,
      store,
      datasets,
      runStore,
      newId: () => `id-${n++}`,
    });

    // When: submitting with trials=3
    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      trials: 3,
    });
    const done = await waitTerminal(store, created.id);

    // Then: 3 dispatches (trials 0..2), one child run per (case, trial), trials persisted for a re-drive
    expect(done.status).toBe("succeeded");
    expect(seenTrials.filter((t): t is number => t !== undefined).sort()).toEqual([0, 1, 2]);
    expect(done.orchestration?.trials).toBe(3);
    const children = await runStore.list("acme", { scorecardId: created.id });
    expect(children.filter((c) => c.caseId === "c1")).toHaveLength(3);

    // And: get() derives the trial roll-up — c1 passed 2/3 and is flaky
    const detail = await service.get(created.id);
    expect(detail?.trialSummary).toMatchObject({ cases: 1, flakyCases: 1, minTrials: 3, maxTrials: 3 });
    expect(detail?.trialSummary?.passAt1).toBeCloseTo(2 / 3, 10);
  });

  it("a single-run batch carries no trial index and no trialSummary (backward compatible)", async () => {
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
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      runStore,
      newId: () => `id-${n++}`,
    });

    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, created.id);

    const children = await runStore.list("acme", { scorecardId: created.id });
    expect(children.filter((c) => c.caseId === "c1")).toHaveLength(1);
    expect(children[0]?.result?.trial).toBeUndefined();
    const detail = await service.get(created.id);
    expect(detail?.trialSummary).toBeUndefined();
    expect(detail?.orchestration?.trials).toBeUndefined();
  });
});

describe("ScorecardService usage metering", () => {
  it("meters each case's harness LLM cost against the billing tenant (meter-only, never blocks)", async () => {
    // Given: a dispatch whose result carries an llm_call cost
    const costDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { usd: 0.05, inputTokens: 200, outputTokens: 0 } }],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const usage = inMemoryUsageMeter();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: costDispatch,
      store,
      datasets,
      usage,
      newId: () => `id-${n++}`,
    });

    // When: a managed batch runs
    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, created.id);

    // Then: the workspace's metered usage reflects the harness LLM cost (one evaluation)
    const u = usage.usage("acme");
    expect(u).toMatchObject({ usd: 0.05, tokens: 200, evaluations: 1 });
    expect(u.bySource.harness).toMatchObject({ usd: 0.05, tokens: 200, evaluations: 1 });
  });
});

describe("ScorecardService — adaptive batch concurrency (pressure shrinks the effective width)", () => {
  const fourCaseDataset: Dataset = {
    id: "ad",
    version: "1.0.0",
    cases: ["c1", "c2", "c3", "c4"].map((id) => ({
      id,
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
    tags: [],
  };

  // A parking dispatcher that records the in-flight high-water mark (the observable effective width).
  function parkingDispatcher() {
    let inFlight = 0;
    let maxSeen = 0;
    const pending: Array<() => void> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise<void>((resolve) =>
          pending.push(() => {
            inFlight -= 1;
            resolve();
          }),
        );
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return {
      dispatcher,
      releaseAll: () => {
        while (pending.length > 0) pending.shift()?.();
      },
      pendingCount: () => pending.length,
      max: () => maxSeen,
    };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("a scheduler queue spike halves the effective width (4 workers → 2 concurrent dispatches)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", fourCaseDataset);
    const park = parkingDispatcher();
    const events: string[] = [];
    const service = new ScorecardService({
      dispatcher: park.dispatcher,
      store,
      datasets,
      concurrency: 4,
      queueDepth: () => 100, // pressured from the start
      queuePressure: 10,
      onOrchestrationEvent: (e) => {
        if (e.kind === "concurrency_adapted") events.push(`${e.previous}->${e.effective}`);
      },
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
    });
    await until(() => park.pendingCount() === 2); // only 2 of 4 cases dispatched under pressure
    expect(park.max()).toBe(2);
    // Drain: release the parked pair, the remaining two follow (still ≤2 at a time).
    park.releaseAll();
    await until(() => park.pendingCount() === 2);
    park.releaseAll();
    await until(async () => (await store.get(rec.id))?.status === "succeeded");
    expect(park.max()).toBe(2);
    expect(events).toContain("4->2"); // the shrink transition surfaced to the metrics seam
  });

  it("an open circuit on one of the batch's runtimes halves the width; all-open floors it at 1", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", fourCaseDataset);
    const park = parkingDispatcher();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    breaker.failure("acme:rt-a"); // rt-a is known-dead before the batch starts
    const service = new ScorecardService({
      dispatcher: park.dispatcher,
      store,
      datasets,
      concurrency: 4,
      breaker,
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
      runtime: "rt-a,rt-b", // sharded — rt-a open → factor 0.5 → effective 2 (cases spill to rt-b and succeed)
    });
    await until(() => park.pendingCount() === 2);
    expect(park.max()).toBe(2);
    park.releaseAll();
    await until(() => park.pendingCount() === 2);
    park.releaseAll();
    await until(async () => (await store.get(rec.id))?.status === "succeeded");
    expect(park.max()).toBe(2);

    // All targets open → trickle at 1, then AUTO-RESTORE: the trickle probe succeeds (spillover reports
    // breaker.success), the circuits close, and the remaining cases fan back out without any reset call.
    breaker.failure("acme:rt-a");
    breaker.failure("acme:rt-b");
    const park2 = parkingDispatcher();
    const service2 = new ScorecardService({
      dispatcher: park2.dispatcher,
      store,
      datasets,
      concurrency: 4,
      breaker,
    });
    const rec2 = await service2.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
      runtime: "rt-a,rt-b",
    });
    await until(() => park2.pendingCount() === 1);
    expect(park2.max()).toBe(1); // fully-open shard list → serialized probe, never a full stop
    park2.releaseAll(); // the probe succeeds on rt-a → breaker.success closes THAT circuit → width doubles
    await until(() => park2.pendingCount() === 2);
    park2.releaseAll(); // rt-b stays open (its cases spill to healthy rt-a first), so half-width is the plateau
    await until(() => park2.pendingCount() === 1);
    park2.releaseAll();
    await until(async () => (await store.get(rec2.id))?.status === "succeeded");
    expect(park2.max()).toBe(2); // trickle → half-width restore observed, no reset call anywhere
  });
});

describe("ScorecardService — in-batch OOM auto-boost (opt-in)", () => {
  const oneCaseDataset: Dataset = {
    id: "od",
    version: "1.0.0",
    cases: [
      { id: "m1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };
  const oomTemplate: HarnessTemplateSpec = {
    kind: "command",
    category: "cli-agent",
    id: "hungry",
    version: "1",
    resources: { memoryMb: 64 },
    setup: [],
    command: "run",
    env: {},
    params: {},
    trace: { kind: "none" },
  };
  async function fixtures() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", oneCaseDataset);
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", oomTemplate);
    await instances.register("acme", {
      template: { id: "hungry", version: "1" },
      id: "hungry",
      version: "1.0.0",
      pins: {},
    });
    return { datasets, instances };
  }
  // A dispatcher that OOM-kills any job under `needMb` of declared memory — the boost loop's foil.
  function oomBelow(needMb: number) {
    const memoriesSeen: number[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        const mb = job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.memoryMb ?? 0) : 0;
        memoriesSeen.push(mb);
        if (mb < needMb) throw new UpstreamError("UPSTREAM_ERROR", { signal: "OOM_KILLED" }, "task OOM-killed");
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, memoriesSeen };
  }
  const waitTerminal = async (store: InMemoryScorecardStore, id: string) => {
    for (let i = 0; i < 200; i++) {
      const rec = await store.get(id);
      if (rec && rec.status !== "queued" && rec.status !== "running") return rec;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("not terminal");
  };

  it("with the knob set, an OOM case re-dispatches with doubled memory until it fits (64 → 128 → 256)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(256);
    const boosts: number[] = [];
    const service = new ScorecardService({
      dispatcher: oom.dispatcher,
      store,
      datasets,
      harnesses: instances,
      onOrchestrationEvent: (e) => {
        if (e.kind === "oom_escalated") boosts.push(e.memoryMb);
      },
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
      oomAutoBoost: true,
    });
    expect(rec.orchestration?.oomAutoBoost).toBe(true); // persisted — resume keeps the behavior
    const done = await waitTerminal(store, rec.id);
    expect(done.status).toBe("succeeded");
    expect(oom.memoriesSeen).toEqual([64, 128, 256]); // in-batch compounding, no retry-failed round-trip
    expect(boosts).toEqual([128, 256]); // each boost surfaced to the metrics seam
    expect(done.steps?.some((st) => st.message.includes("OOM auto-boost 64 → 128Mb"))).toBe(true);
  });

  it("without the knob, the OOM stays a fatal infra failure (no hidden re-runs)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(256);
    const service = new ScorecardService({ dispatcher: oom.dispatcher, store, datasets, harnesses: instances });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
    });
    const done = await waitTerminal(store, rec.id);
    expect(oom.memoriesSeen).toEqual([64]); // exactly one attempt
    expect(done.scorecard?.results[0]?.failure?.code).toBe("OOM_KILLED"); // classification preserved for retry-failed
  });

  it("boosting stops at the cap — a case that can never fit surfaces its OOM instead of looping", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(Number.POSITIVE_INFINITY); // insatiable
    const service = new ScorecardService({ dispatcher: oom.dispatcher, store, datasets, harnesses: instances });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
      oomAutoBoost: true,
    });
    const done = await waitTerminal(store, rec.id);
    expect(oom.memoriesSeen[oom.memoriesSeen.length - 1]).toBe(16_384); // capped, then surfaced
    expect(done.scorecard?.results[0]?.failure?.code).toBe("OOM_KILLED");
  });
});

describe("ScorecardService — trace-correlation runId on batch jobs (observability ③)", () => {
  it("every dispatched case job carries evd-<batchId>-<caseId> (observers derive it with zero lookups)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "cd",
      version: "1.0.0",
      cases: [
        { id: "x1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      ],
      tags: [],
    });
    const jobs: AgentJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    const service = new ScorecardService({ dispatcher: capture, store, datasets, newId: () => "sc-rid" });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "cd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    });
    for (let i = 0; i < 100 && (await store.get(rec.id))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.runId).toBe(`evd-${rec.id}-x1`);
  });
});

describe("ScorecardService.submit — run-time grading plan (dataset stays pure data)", () => {
  const planDataset: Dataset = {
    id: "pd",
    version: "1.0.0",
    cases: [
      {
        id: "c1",
        env: { kind: "prompt" },
        task: "t",
        expected: "42",
        graders: [{ id: "steps" }],
        timeoutSec: 60,
        tags: [],
      },
    ],
    tags: [],
  };
  const capture = (jobs: AgentJob[]): Dispatcher => ({
    async dispatch(job) {
      jobs.push(job);
      return { ...caseResult(true), caseId: job.evalCase.id };
    },
  });

  it("a graders plan replaces every dispatched case's defaults and is persisted in orchestration (resume/retry parity)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", planDataset);
    const jobs: AgentJob[] = [];
    const service = new ScorecardService({ dispatcher: capture(jobs), store, datasets, newId: () => "sc-plan" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      graders: [{ id: "answer-match" }, { id: "cost" }],
    });
    for (let i = 0; i < 100 && (await store.get("sc-plan"))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.evalCase.graders.map((g) => g.id)).toEqual(["answer-match", "cost"]); // the plan, not the case default
    expect(jobs[0]?.evalCase.expected).toBe("42"); // row data rides along untouched
    const rec = await store.get("sc-plan");
    expect(rec?.orchestration?.graders?.map((g) => g.id)).toEqual(["answer-match", "cost"]);
  });

  it("without a plan, each case keeps its own default graders and nothing extra is persisted", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", planDataset);
    const jobs: AgentJob[] = [];
    const service = new ScorecardService({ dispatcher: capture(jobs), store, datasets, newId: () => "sc-noplan" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    for (let i = 0; i < 100 && (await store.get("sc-noplan"))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.evalCase.graders.map((g) => g.id)).toEqual(["steps"]);
    expect((await store.get("sc-noplan"))?.orchestration?.graders).toBeUndefined();
  });
});

// Rich-domain-core S2 (docs/architecture/rich-domain-core.md): the previously-unguarded terminal re-write races
// are now read-guarded through the ScorecardBatch model — the first terminal write wins, a late loser is a skip.
describe("ScorecardService — first terminal write wins (rich domain guards)", () => {
  // A gating dispatcher — holds every case at the gate until release() so the test can act mid-flight.
  function gatedDispatcher() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        await gate;
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, release: () => release() };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("a late track success cannot overwrite a superseded batch (supersede raced ahead of the abort signal)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const gate = gatedDispatcher();
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      newId: () => "sc-race-ok",
      onComplete: async (_tenant, rec) => {
        completed.push(rec.status);
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await until(async () => (await store.get("sc-race-ok"))?.status === "running");
    // Simulate the exact race window: the supersede status write landed, but the in-flight abort has NOT fired.
    await store.update("sc-race-ok", {
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
    });
    gate.release();
    await until(() => completed.length === 1); // the track loop has fully settled

    const final = await store.get("sc-race-ok");
    expect(final?.status).toBe("superseded"); // pre-fix: the unguarded write revived it to succeeded
    expect(final?.error?.code).toBe("SUPERSEDED");
    expect(final?.scorecard).toBeUndefined(); // the losing terminal write is a full skip, not a partial merge
  });

  it("a late track failure cannot overwrite a superseded batch", async () => {
    const store = new InMemoryScorecardStore();
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
    const gate = gatedDispatcher();
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run() {
          throw new Error("judge boom"); // fails the batch in the judges phase, after the supersede lands
        },
      },
      newId: () => "sc-race-fail",
      onComplete: async (_tenant, rec) => {
        completed.push(rec.status);
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    await until(async () => (await store.get("sc-race-fail"))?.status === "running");
    await store.update("sc-race-fail", {
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
    });
    gate.release();
    await until(() => completed.length === 1);

    const final = await store.get("sc-race-fail");
    expect(final?.status).toBe("superseded"); // pre-fix: the unguarded write flipped it to failed
    expect(final?.error?.code).toBe("SUPERSEDED"); // the judge failure never replaces the supersede marker
  });

  it("planBatch does not revive a superseded batch to running (Temporal activity racing the workflow cancel)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: new InMemoryRunStore() });
    await store.create({
      id: "sc-plan-sup",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
      orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "wf-sup" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const plan = await service.planBatch("sc-plan-sup");
    expect(plan.caseIds).toEqual(["c1"]); // still answers the workflow (runBatchCase skips per case)
    expect((await store.get("sc-plan-sup"))?.status).toBe("superseded"); // pre-fix: blindly re-written to running
  });

  it("finalizeBatch cannot overwrite a superseded batch and skips its completion notification (Temporal)", async () => {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      onComplete: async (_tenant, rec) => {
        completed.push(rec.id);
      },
    });
    await store.create({
      id: "sc-fin-sup",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
      orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "wf-fin" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: { ...caseResult(true), caseId: "c1" },
      parentScorecardId: "sc-fin-sup",
      createdAt: "2026-07-10T00:00:01.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    });

    await service.finalizeBatch("sc-fin-sup");
    const final = await store.get("sc-fin-sup");
    expect(final?.status).toBe("superseded"); // pre-fix: finalize revived it to succeeded
    expect(final?.summary).toBeUndefined(); // the losing terminal write is a full skip
    expect(completed).toEqual([]); // a replaced batch's completion notification is noise
  });
});

// User stop — cancel a running batch and free its runtime (cooperative abort + cancelQueued + cancelLeased + killCase).
describe("ScorecardService.cancel — user stop", () => {
  it("marks a running batch cancelled and requests both reclaim paths (queued scheduler + self-hosted lease), keyed by batch id", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-run", { status: "running" }));
    let queuedPred: ((j: AgentJob) => boolean) | undefined;
    let leasedPred: ((j: AgentJob) => boolean) | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      cancelQueued: (p) => {
        queuedPred = p;
        return 0;
      },
      cancelLeased: (p) => {
        leasedPred = p;
        return 1;
      },
    });

    const stopped = await service.cancel({ tenant: "acme", id: "sc-run" });

    expect(stopped.status).toBe("cancelled");
    expect(stopped.error).toEqual({ code: "CANCELLED", message: "Stopped by user" });
    // Both reclaim predicates target THIS batch (and only this batch).
    expect(queuedPred?.({ batchId: "sc-run" } as AgentJob)).toBe(true);
    expect(leasedPred?.({ batchId: "sc-run" } as AgentJob)).toBe(true);
    expect(leasedPred?.({ batchId: "other" } as AgentJob)).toBe(false);
  });

  it("force-kills only the RUNNING managed child runs, targeting each child's runtime", async () => {
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    await store.create(record("sc-k", { status: "running", runtime: "nomad-1" }));
    await runStore.create({
      id: "r1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "running",
      parentScorecardId: "sc-k",
      trigger: "scorecard",
      runtime: "nomad-1",
      createdAt: "t",
      updatedAt: "t",
    });
    await runStore.create({
      id: "r2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "succeeded",
      parentScorecardId: "sc-k",
      trigger: "scorecard",
      createdAt: "t",
      updatedAt: "t",
    });
    const killed: Array<{ runtime?: string; caseId: string }> = [];
    const service = new ScorecardService({
      dispatcher,
      store,
      runStore,
      datasets: new InMemoryDatasetRegistry(),
      killCase: async (_tenant, runtime, caseId) => {
        killed.push({ runtime, caseId });
      },
    });

    await service.cancel({ tenant: "acme", id: "sc-k" });

    expect(killed).toEqual([{ runtime: "nomad-1", caseId: "c1" }]); // finished c2 is left alone
  });

  it("a missing or cross-workspace scorecard is a NotFound (no existence leak)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-other", { tenant: "other", status: "running" }));
    const service = svc(store);
    await expect(service.cancel({ tenant: "acme", id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.cancel({ tenant: "acme", id: "sc-other" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stopping an already-finished batch is a ConflictError (the domain rejects a terminal transition)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-done", { status: "succeeded" }));
    const service = svc(store);
    await expect(service.cancel({ tenant: "acme", id: "sc-done" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("ScorecardService.delete — hard delete (creator-or-admin, terminal only, child-run cascade)", () => {
  const principal = (roles: string[], subject = "u-alice"): Principal => ({
    subject,
    workspace: "acme",
    roles,
    via: "oidc",
  });
  const childRun = (id: string, scorecardId: string): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: id,
    status: "succeeded",
    parentScorecardId: scorecardId,
    trigger: "scorecard",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
  });

  it("the creator (non-admin member) deletes their own terminal batch — the record AND its child runs are gone", async () => {
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    await runStore.create(childRun("c1", "sc-1"));
    await runStore.create(childRun("c2", "sc-1"));
    await runStore.create(childRun("c3", "sc-other")); // another batch's child survives
    const service = new ScorecardService({ dispatcher, store, runStore, datasets: new InMemoryDatasetRegistry() });

    const res = await service.delete({ principal: principal(["member"]), id: "sc-1" });

    expect(res).toEqual({ workspace: "acme", id: "sc-1", deleted: true, childRuns: 2 });
    expect(await store.get("sc-1")).toBeUndefined();
    expect(await runStore.list("acme", { scorecardId: "sc-1" })).toEqual([]);
    expect((await runStore.list("acme", { scorecardId: "sc-other" })).map((r) => r.id)).toEqual(["c3"]);
  });

  it("an admin who is not the creator can delete; a member who is neither creator nor admin is FORBIDDEN", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    const service = svc(store);

    await expect(service.delete({ principal: principal(["member"], "u-bob"), id: "sc-1" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await store.get("sc-1")).toBeDefined(); // nothing deleted on deny

    await expect(service.delete({ principal: principal(["admin"], "u-carol"), id: "sc-1" })).resolves.toMatchObject({
      deleted: true,
    });
    expect(await store.get("sc-1")).toBeUndefined();
  });

  it("a queued/running batch is a ConflictError even for an admin — stop (cancel) it first", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-live", { status: "running", createdBy: "u-alice" }));
    const service = svc(store);
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-live" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await store.get("sc-live")).toBeDefined();
  });

  it("a missing or cross-workspace scorecard is a NotFound (no existence leak); no runStore → childRuns 0", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-other", { tenant: "other", createdBy: "u-alice" }));
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    const service = svc(store); // no runStore configured (dev wiring)
    await expect(service.delete({ principal: principal(["admin"]), id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-other" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-1" })).resolves.toMatchObject({
      childRuns: 0,
    });
  });
});
