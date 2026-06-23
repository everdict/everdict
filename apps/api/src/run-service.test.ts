import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import type { AgentJob, CaseResult, EvalCase } from "@assay/core";
import { InMemoryRunStore } from "@assay/db";
import { describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

function resultFor(job: AgentJob, usd = 0): CaseResult {
  return {
    caseId: job.evalCase.id,
    harness: `${job.harness.id}@${job.harness.version}`,
    trace: usd ? [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd } }] : [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };
}

const okDispatcher: Dispatcher = {
  async dispatch(job) {
    return resultFor(job);
  },
};
const failDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("boom");
  },
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let n = 0;
const ids = () => `run-${n++}`;

describe("RunService", () => {
  it("submit → queued → 디스패치 성공 시 succeeded + result 저장", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    expect(rec.status).toBe("queued");
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.caseId).toBe("c1");
  });

  it("디스패치 실패 시 failed + error 봉투", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: failDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("failed");
    expect(done?.error?.message).toBe("boom");
  });

  it("예산 초과면 submit 이 던진다 (run 생성 안 함, 402 매핑)", async () => {
    const store = new InMemoryRunStore();
    const budget = inMemoryBudget({ limitFor: () => ({ runs: 1 }) });
    const svc = new RunService({ dispatcher: okDispatcher, store, budget, newId: ids });
    await svc.submit({ tenant: "free", harness: { id: "s", version: "0" }, case: CASE });
    await expect(svc.submit({ tenant: "free", harness: { id: "s", version: "0" }, case: CASE })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      status: 402,
    });
  });

  it("계측: 요청 override > 워크스페이스 정책 > off, 결정값을 job.meterUsage 로 실어 보낸다", async () => {
    const seen: Array<boolean | undefined> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.meterUsage);
        return resultFor(job);
      },
    };
    // 정책: acme 만 on. 요청 override 가 정책을 이긴다.
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      meterUsageFor: (t) => t === "acme",
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE }); // 정책 on
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE }); // 정책 off
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE, meterUsage: false }); // override off
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE, meterUsage: true }); // override on
    await flush();
    expect(seen).toEqual([true, false, false, true]);
  });

  it("judge 모델: 요청 override > 워크스페이스 기본 > 없음, 결정값을 job.judge 로 실어 보낸다", async () => {
    const seen: Array<AgentJob["judge"]> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.judge);
        return resultFor(job);
      },
    };
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      // 워크스페이스 기본: acme 만 judge 모델 설정.
      judgeFor: async (t) => (t === "acme" ? { provider: "openai", model: "gpt-5.4-mini" } : undefined),
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE }); // 기본 적용
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE }); // 기본 없음
    await svc.submit({
      tenant: "beta",
      harness: { id: "s", version: "0" },
      case: CASE,
      judge: { model: "claude-opus-4-8", provider: "anthropic" },
    }); // override
    await flush();
    expect(seen[0]).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
    expect(seen[1]).toBeUndefined(); // 기본 없으면 job.judge 미설정 → agent 에서 judge skip
    expect(seen[2]).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("계측 정책은 async 가능(DB 설정 스토어) — await 해서 job 에 싣는다", async () => {
    let seen: boolean | undefined;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen = job.meterUsage;
        return resultFor(job);
      },
    };
    // DB 조회처럼 Promise<boolean> 반환
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      meterUsageFor: async (t) => t === "acme",
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toBe(true);
  });

  it("정책 없으면 기본 off (job.meterUsage=false)", async () => {
    let seen: boolean | undefined;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen = job.meterUsage;
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher, store: new InMemoryRunStore(), newId: ids });
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toBe(false);
  });

  it("비공개 repo: env.source.connectionId → repoTokenFor 로 resolve 해 job.repoToken 으로 실어 보낸다", async () => {
    const seen: Array<AgentJob["repoToken"]> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.repoToken);
        return resultFor(job);
      },
    };
    const calls: Array<{ tenant: string; connectionId: string }> = [];
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      repoTokenFor: async (tenant, connectionId) => {
        calls.push({ tenant, connectionId });
        return connectionId === "conn-acme" ? "gho_resolved" : undefined;
      },
    });
    const gitCase = (connectionId?: string): EvalCase => ({
      ...CASE,
      env: {
        kind: "repo",
        source: { git: "https://github.com/acme/p.git", ref: "main", ...(connectionId ? { connectionId } : {}) },
      },
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: gitCase("conn-acme") }); // 해석됨
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: gitCase("conn-missing") }); // 미해석
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: gitCase() }); // connectionId 없음(public)
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE }); // files 시드(비-git)
    await flush();
    expect(seen).toEqual(["gho_resolved", undefined, undefined, undefined]);
    // connectionId 없는 케이스/비-repo 는 repoTokenFor 를 아예 호출하지 않는다.
    expect(calls).toEqual([
      { tenant: "acme", connectionId: "conn-acme" },
      { tenant: "acme", connectionId: "conn-missing" },
    ]);
  });

  it("완료 시 cost 가 settle 된다", async () => {
    const store = new InMemoryRunStore();
    const budget = inMemoryBudget({ limitFor: () => ({ usd: 1 }) });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        return resultFor(job, 0.25);
      },
    };
    const svc = new RunService({ dispatcher, store, budget, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(budget.usage("t").usd).toBeCloseTo(0.25);
    expect((await svc.get(rec.id))?.status).toBe("succeeded");
  });

  it("종료 시 웹훅을 쏜다", async () => {
    const store = new InMemoryRunStore();
    const calls: Array<{ url: string; status: string }> = [];
    const fakeFetch = (async (url: string | URL, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), status: body.status });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids, fetch: fakeFetch });
    await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: CASE,
      webhookUrl: "https://hook.example/cb",
    });
    await flush();
    await flush();
    expect(calls[0]?.url).toBe("https://hook.example/cb");
    expect(calls[0]?.status).toBe("succeeded");
  });
});
