import type { Dispatcher } from "@assay/backends";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  type Dataset,
  type HarnessTemplateSpec,
  NotFoundError,
  type Scorecard,
  type TraceEvent,
} from "@assay/core";
import { InMemoryRunStore, InMemoryScorecardStore, type ScorecardRecord } from "@assay/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
} from "@assay/registry";
import type { TraceSource, TraceSourceConfig } from "@assay/trace";
import { describe, expect, it } from "vitest";
import { ScorecardService } from "./scorecard-service.js";

const dispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("unused in diff tests");
  },
};

// 한 케이스에 tests-pass 점수 1건. pass 를 바꿔 회귀/개선을 만든다.
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

describe("ScorecardService.submit — requireRuntime 정책(local 폴백 금지)", () => {
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

  it("정책 ON + runtime 없으면 400(BadRequest) — 데이터셋 해석 전에 fail-fast", async () => {
    await expect(build(true).submit(input())).rejects.toBeInstanceOf(BadRequestError);
  });

  it("정책 ON + runtime(등록 런타임/self) 지정 시 게이트 통과 — 이후 단계로 진행(없는 데이터셋이라 NotFound)", async () => {
    // BadRequest 가 아니라 NotFound 라는 것 = 런타임 게이트를 통과했다는 증거(게이트는 target 존재만 본다).
    await expect(build(true).submit(input({ runtime: "self:laptop" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("정책 OFF(dev)이면 runtime 없이도 게이트를 통과한다(기존 동작 불변)", async () => {
    await expect(build(false).submit(input())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScorecardService.diff", () => {
  it("pass 전이를 회귀/개선으로 보고한다", async () => {
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

  it("없는/타 워크스페이스 스코어카드 → NotFoundError(404)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("other", { tenant: "beta", scorecard: scorecard(true) }));
    await expect(svc(store).diff("acme", "base", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).diff("acme", "base", "other")).rejects.toBeInstanceOf(NotFoundError); // 타 워크스페이스
  });

  it("미완료(scorecard 없음) → BadRequestError(400)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("queued", { status: "queued" }));
    await expect(svc(store).diff("acme", "base", "queued")).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("ScorecardService.leaderboard", () => {
  // judge passRate + primary model 을 가진 완료 스코어카드.
  const scored = (id: string, harnessVersion: string, model: string, passRate: number): Partial<ScorecardRecord> => ({
    harness: { id: "h", version: harnessVersion },
    summary: [{ metric: "judge", count: 10, mean: passRate, passRate }],
    models: { observed: [model], primary: model },
  });

  it("한 데이터셋의 (harness × model) 을 metric 내림차순으로 랭킹하고 워크스페이스로 스코프한다", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("a", scored("a", "1", "gpt-5", 0.6)));
    await store.create(record("b", scored("b", "2", "claude-opus-4-8", 0.9)));
    await store.create(record("other", { ...scored("other", "2", "x", 1.0), tenant: "beta" })); // 타 워크스페이스
    const lb = await svc(store).leaderboard("acme", { datasetId: "d", metric: "judge" });
    expect(lb.rows.map((r) => [r.rank, r.harness.version, r.model, r.score])).toEqual([
      [1, "2", "claude-opus-4-8", 0.9],
      [2, "1", "gpt-5", 0.6],
    ]);
    expect(lb.rows.some((r) => r.model === "x")).toBe(false); // beta 워크스페이스 제외
  });
});

describe("ScorecardService.backfillModels", () => {
  // 트레이스에 관측 모델을 가진 완료 스코어카드(구 레코드처럼 models 필드는 없음).
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

  it("models 없는 succeeded 레코드를 저장 트레이스 관측으로 채운다(멱등; 미완료/기존 models 는 스킵)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("old", { scorecard: scWithModel("gpt-4o") })); // models 없음
    await store.create(record("queued", { status: "queued" })); // 산출물 없음 → 스킵
    await store.create(
      record("already", { scorecard: scWithModel("o3"), models: { observed: ["o3"], primary: "o3" } }),
    );

    const res = await svc(store).backfillModels("acme");
    expect(res.updated).toBe(1); // old 만
    expect((await store.get("old"))?.models?.primary).toBe("gpt-4o");

    // 멱등: 두 번째 실행은 채울 게 없다.
    expect((await svc(store).backfillModels("acme")).updated).toBe(0);
  });
});

// 한 케이스(c1)만 가진 데이터셋. pull 인제스트 정렬 대상.
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

// 백그라운드 trackPull 이 끝날 때까지(terminal status) 폴링한다.
async function waitTerminal(store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> {
  for (let i = 0; i < 50; i++) {
    const rec = await store.get(id);
    if (rec && (rec.status === "succeeded" || rec.status === "failed")) return rec;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("pull 인제스트가 끝나지 않음");
}

describe("ScorecardService.ingestPull", () => {
  it("trace source 에서 트레이스를 당겨와 메트릭을 도출하고 succeeded 로 저장한다", async () => {
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
    // authSecret → SecretStore 값 → Authorization: Bearer 헤더로 trace source 에 주입
    expect(captured?.headers?.authorization).toBe("Bearer secret-xyz");
  });

  it("없는 데이터셋 → NotFoundError(404)", async () => {
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

  it("buildTraceSource 미설정 → run 이 failed 로 종료(BAD_REQUEST)", async () => {
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

describe("ScorecardService.submit — 비공개 repo repoToken 주입(케이스별)", () => {
  it("케이스 env.source.connectionId → repoTokenFor resolve → 케이스별 job.repoToken; public/비-git 은 미주입", async () => {
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
    // 연결은 개인 소유 → repoTokenFor 는 owner(제출자 subject)로 resolve.
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
    expect(calls).toEqual([{ owner: "u-alice", connectionId: "conn-1" }]); // files 케이스는 resolver 미호출
  });

  it("디스패치 이후 구간(judges) 실패 → status=failed + error.phase=judges + 부분 결과 보존(가시성)", async () => {
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
    expect(rec.error?.phase).toBe("judges"); // "어떤 구간에서" — judges 단계 실패
    expect(rec.error?.message).toContain("judge boom"); // "어떻게" — 사유
    // 부분 결과 보존: 디스패치까지 모인 케이스 결과가 실패 레코드에도 남아 가시성을 준다.
    expect(rec.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]);
    // 진행 과정(스텝) 타임라인 — 케이스 완료 + judges 구간 실패가 순서대로 기록된다.
    expect(rec.steps?.some((s) => s.phase === "case" && s.caseId === "c1")).toBe(true);
    expect(rec.steps?.some((s) => s.phase === "judges" && s.status === "failed")).toBe(true);
  });

  it("완료 시 onComplete 콜백을 최신 레코드로 호출(알림 훅)", async () => {
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

describe("ScorecardService.submit — 리더보드 model 축 캡처", () => {
  // 각 케이스가 llm_call(model) 을 남기는 dispatcher — 관측 모델의 출처.
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

  it("트레이스 관측 모델을 succeeded 레코드의 models 로 저장한다(관측 우선)", async () => {
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

  it("inline judge config 모델을 succeeded 레코드의 judgeModels 로 저장한다(judge 축)", async () => {
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
      judge: { provider: "openai", model: "gpt-5.4-mini" }, // 채점자
    });
    const rec = await waitTerminal(store, "sc-judge");
    expect(rec.status).toBe("succeeded");
    expect(rec.models?.primary).toBe("gpt-4o"); // 하니스가 쓴 LLM
    expect(rec.judgeModels).toEqual(["gpt-5.4-mini"]); // 채점자 — 별개 축
  });
});

describe("ScorecardService.submit — 자식 run 팬아웃(runStore)", () => {
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

  it("runStore 설정 시 케이스마다 자식 run 을 만들고, 활동 리스트엔 숨기며, scorecard.runIds 로 참조한다", async () => {
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
      newId: () => `sc-${n++}`, // sc-0 = 스코어카드, sc-1 = 케이스 c1 의 자식 run
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-0");
    expect(rec.status).toBe("succeeded");
    expect(rec.runIds).toEqual(["sc-1"]); // 팬아웃한 자식 run 참조
    expect(rec.scorecard).toBeUndefined(); // 저장 dedup — 무거운 embed 는 저장하지 않는다(runIds 만)

    const child = await runStore.get("sc-1");
    expect(child?.status).toBe("succeeded");
    expect(child?.parentScorecardId).toBe("sc-0");
    expect(child?.trigger).toBe("scorecard");
    expect(child?.caseId).toBe("c1");

    // get 은 자식 run 으로 scorecard 를 hydrate — 응답 형태는 embed 시절과 동일(웹/diff 불변).
    const hydrated = await service.get("sc-0");
    expect(hydrated?.scorecard?.results).toHaveLength(1);
    expect(hydrated?.scorecard?.results[0]?.caseId).toBe("c1");
    // write-back 으로 케이스 점수(grader/judge/metric)가 자식에 보존 → hydrate 시 그대로 돌아온다.
    expect(hydrated?.scorecard?.results[0]?.scores[0]?.metric).toBe("tests_pass");

    // 활동 리스트(기본)는 자식을 숨기고, scorecardId 로는 그 배치 자식이 보인다.
    expect(await runStore.list("acme")).toEqual([]);
    expect((await runStore.list("acme", { scorecardId: "sc-0" })).map((r) => r.id)).toEqual(["sc-1"]);
  });

  it("diff 는 dedup(runIds) 스코어카드도 hydrate 해서 회귀/개선을 계산한다", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    // pass 를 바꾸는 dispatcher — base 는 pass, cand 는 fail(회귀).
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
    // 서비스별 독립 카운터 — base 스코어카드=b-0(+자식 b-1), cand 스코어카드=c-0(+자식 c-1).
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

    // 두 스코어카드 모두 embed 없이 runIds 만 저장됐지만, diff 는 hydrate 해서 pass→fail 회귀를 잡는다.
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

  it("runStore 미설정이면 자식 run 없이 임베드 scorecard 만(현행 유지)", async () => {
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
    expect(rec.scorecard?.results).toHaveLength(1); // 임베드 결과는 그대로
  });
});

describe("ScorecardService.submit — 요청 concurrency 가 runSuite 병렬도로 흐른다", () => {
  // 동시 in-flight 디스패치 수를 계측하는 dispatcher — 각 dispatch 가 잠깐 지연돼야 병렬이 쌓인다.
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

  // 케이스 N 개짜리 데이터셋(병렬도 검증용 — 케이스가 동시도보다 많아야 의미 있다).
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

  it("요청 concurrency=3 → 동시에 3개까지 디스패치(서비스 기본을 덮어쓴다)", async () => {
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
    expect(peak()).toBe(3); // 서비스 기본(1)이 아니라 요청값(3)이 적용됐다
  });

  it("요청 concurrency 미지정 → 서비스 기본 동시도(=1)로 직렬 디스패치", async () => {
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

describe("ScorecardService.submit — 제출 시점 임시 핀(pins) + origin provenance", () => {
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

  it("pins 는 dispatched harnessSpec 의 해당 슬롯 이미지만 스왑하고 origin.pinOverrides 로 기록된다(레지스트리 무변경)", async () => {
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
    expect(rec.harness).toEqual({ id: "bu", version: "1.0.0" }); // 임시 핀은 버전을 만들지 않는다(기반 버전 기록)
    expect(rec.origin).toMatchObject({
      source: "github-actions",
      repo: "acme/app",
      prNumber: 7,
      pinOverrides: { planner: "p:pr-7" }, // 무엇으로 평가했는지의 재현 근거
    });
    await waitTerminal(store, "sc-pins");
    const spec = jobs[0]?.harnessSpec;
    if (spec?.kind !== "service") throw new Error("expected service harnessSpec");
    expect(spec.services.map((s) => s.image)).toEqual(["p:pr-7", "b:1"]); // planner 만 스왑
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]); // 레지스트리 무변경
  });

  it("알 수 없는 슬롯 핀 → BadRequest (핀 무시 채 통과 방지 — 폴백 없음)", async () => {
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

  it("레지스트리 미설정 + pins → BadRequest (빌트인 하니스에 핀은 불가)", async () => {
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

  it("origin 은 pins 없이도 그대로 기록된다(schedule/web/api 공통 provenance)", async () => {
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

  it("submittedBy(제출자)는 레코드 createdBy 로 스탬프된다 — origin(어디서)과 짝인 실행자(누가)", async () => {
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

  it("ingest(트레이스 업로드)도 submittedBy 를 createdBy 로 스탬프한다", async () => {
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

describe("ScorecardService.submit — 서버측 supersede(같은 PR 재발사가 in-flight 배치를 회수)", () => {
  const twoCaseDataset: Dataset = {
    id: "sd",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };
  // 게이트 dispatcher — 발사 순간을 기록하고, release() 전까지 결과를 보류한다(배치를 "실행 중"에 세워두기 위함).
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

  it("같은 (repo,PR,harness,dataset) 재발사 → 이전 배치 superseded(남은 케이스 미발사·부분 결과 보존·알림 생략)", async () => {
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
      concurrency: 1, // 직렬 — c1 이 게이트에 걸린 동안 c2 는 미발사 상태로 남는다
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
    await until(() => gate.dispatched.length === 1); // c1 발사됨(게이트에 블록)

    const second = await service.submit({ ...base, origin: { ...origin, sha: "new" } });
    // 제출 시점에 이전 배치가 즉시 회수된다(202 응답 이전 — supersede 는 submit 안에서 await).
    const supersededNow = await store.get(first.id);
    expect(supersededNow?.status).toBe("superseded");
    expect(supersededNow?.error?.code).toBe("SUPERSEDED");

    gate.release();
    await until(async () => (await store.get(second.id))?.status === "succeeded");
    await until(async () => (await store.get(first.id))?.scorecard !== undefined); // 첫 배치 종결 대기

    const finalFirst = await store.get(first.id);
    expect(finalFirst?.status).toBe("superseded"); // track 종결이 succeeded 로 되살리지 않는다
    expect(finalFirst?.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]); // 부분 결과(발사된 것만) 보존
    // 남은 케이스(c2)는 첫 배치에서 발사되지 않았다 — 총 발사 = 첫 배치 c1 + 둘째 배치 c1,c2.
    expect(gate.dispatched).toHaveLength(3);
    expect(completions).toEqual([second.id]); // 대체된 배치는 완료 알림 생략
  });

  it("prNumber 없음(merge/dev) 또는 다른 PR 번호의 발사는 supersede 하지 않는다", async () => {
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
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app" } }); // merge — prNumber 없음
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app", prNumber: 8 } }); // 다른 PR
    expect((await store.get(pr7.id))?.status).toBe("running"); // 회수되지 않음
    gate.release();
    await until(async () => (await store.get(pr7.id))?.status === "succeeded"); // 정상 완료
  });
});

describe("ScorecardService.submit — 부분 실행(subset)", () => {
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

  it("limit 이면 앞에서 N개만 돌고 record.subset 이 스탬프된다", async () => {
    const { store, dispatched, service } = await build("sc-lim");
    const rec = await service.submit({ ...submitBase, cases: { limit: 2 } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, limit: 2 });
    await waitTerminal(store, "sc-lim");
    expect([...dispatched].sort()).toEqual(["a", "b"]);
    expect((await store.get("sc-lim"))?.scorecard?.results).toHaveLength(2);
  });

  it("tags 는 any-match 필터(+limit 과 결합)", async () => {
    const { store, dispatched, service } = await build("sc-tag");
    const rec = await service.submit({ ...submitBase, cases: { tags: ["easy"], limit: 1 } });
    expect(rec.subset).toEqual({ total: 3, selected: 1, tags: ["easy"], limit: 1 });
    await waitTerminal(store, "sc-tag");
    expect(dispatched).toEqual(["a"]);
  });

  it("ids 는 명시 선택 — 없는 id 는 400 으로 즉시 거절(조용한 부분 실행 금지)", async () => {
    const { store, dispatched, service } = await build("sc-ids");
    const rec = await service.submit({ ...submitBase, cases: { ids: ["c", "a"] } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, ids: ["c", "a"] });
    await waitTerminal(store, "sc-ids");
    expect([...dispatched].sort()).toEqual(["a", "c"]);
    await expect(service.submit({ ...submitBase, cases: { ids: ["a", "nope"] } })).rejects.toThrow(/nope/);
  });

  it("선택 결과가 0개면 400(태그 불일치)", async () => {
    const { service } = await build("sc-empty");
    await expect(service.submit({ ...submitBase, cases: { tags: ["없는태그"] } })).rejects.toThrow(/케이스가 없습니다/);
  });

  it("cases 미지정이면 전체 실행 + subset 미스탬프(현행 무변경)", async () => {
    const { store, dispatched, service } = await build("sc-all");
    const rec = await service.submit({ ...submitBase });
    expect(rec.subset).toBeUndefined();
    await waitTerminal(store, "sc-all");
    expect(dispatched).toHaveLength(3);
  });
});
