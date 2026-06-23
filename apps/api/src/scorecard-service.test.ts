import type { Dispatcher } from "@assay/backends";
import {
  BadRequestError,
  type CaseResult,
  type Dataset,
  NotFoundError,
  type Scorecard,
  type TraceEvent,
} from "@assay/core";
import { InMemoryScorecardStore, type ScorecardRecord } from "@assay/db";
import { InMemoryDatasetRegistry } from "@assay/registry";
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
      metrics: [],
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
        metrics: [],
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
      metrics: [],
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
    const calls: string[] = [];
    const service = new ScorecardService({
      dispatcher: cap,
      store,
      datasets,
      newId: () => "sc-priv",
      repoTokenFor: async (_t, connectionId) => {
        calls.push(connectionId);
        return connectionId === "conn-1" ? "gho_sc" : undefined;
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "priv", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-priv");
    const byCase = Object.fromEntries(seen.map((s) => [s.caseId, s.repoToken]));
    expect(byCase["git-priv"]).toBe("gho_sc");
    expect(byCase["files-pub"]).toBeUndefined();
    expect(calls).toEqual(["conn-1"]); // files 케이스는 resolver 미호출
  });
});
