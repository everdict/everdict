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
