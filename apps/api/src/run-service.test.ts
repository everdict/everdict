import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import { type AgentJob, BadRequestError, type CaseResult, type EvalCase } from "@assay/core";
import { InMemoryRunStore } from "@assay/db";
import { describe, expect, it, vi } from "vitest";
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

  it("runtime 지정 시 케이스 placement.target 으로 주입해 디스패치한다(scorecard 와 동일 대칭)", async () => {
    const store = new InMemoryRunStore();
    const jobs: AgentJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, runtime: "nomad-seoul" });
    await flush();
    expect(jobs[0]?.evalCase.placement?.target).toBe("nomad-seoul");

    // 대조: runtime 미지정이면 placement 를 건드리지 않는다(기존 동작 불변).
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(jobs[1]?.evalCase.placement).toBeUndefined();
  });

  it("requireRuntime 정책: runtime/self 타깃 없으면 400(BadRequest)이고 레코드도 안 생긴다(local 폴백 금지)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids, requireRuntime: true });
    // 타깃 없음 → 제출 거절(게이트가 budget/record 생성 전에 막는다)
    await expect(svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await svc.list("t")).toHaveLength(0);
    // 등록 런타임 id 또는 self:<러너> 지정 → 게이트 통과, 정상 queued
    const ok = await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: CASE,
      runtime: "self:laptop",
    });
    expect(ok.status).toBe("queued");
  });

  it("list(scorecardId) 는 그 배치 자식만, 기본 list 는 standalone 만(케이스 드릴다운)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const base = {
      tenant: "t",
      harness: { id: "s", version: "0" },
      status: "succeeded" as const,
      createdAt: "t",
      updatedAt: "t",
    };
    await store.create({ ...base, id: "solo", caseId: "c" });
    await store.create({ ...base, id: "ch1", caseId: "c1", parentScorecardId: "sc1", trigger: "scorecard" });
    await store.create({ ...base, id: "ch2", caseId: "c2", parentScorecardId: "sc2", trigger: "scorecard" });
    expect((await svc.list("t")).map((r) => r.id)).toEqual(["solo"]); // 기본: 자식 숨김
    expect((await svc.list("t", { scorecardId: "sc1" })).map((r) => r.id)).toEqual(["ch1"]); // 배치 드릴다운
  });

  it("trigger 를 레코드에 기록한다(활동 뷰 source 축) — 미지정이면 미설정", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, trigger: "web" });
    expect(rec.trigger).toBe("web");
    const bare = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    expect(bare.trigger).toBeUndefined();
  });

  it("셀프호스티드 실행(provenance.ranOn=self-hosted)은 워크스페이스 usd/tokens 버짓을 차감하지 않는다", async () => {
    const store = new InMemoryRunStore();
    const selfHosted: Dispatcher = {
      async dispatch(job) {
        return { ...resultFor(job, 5), provenance: { ranOn: "self-hosted", runner: "laptop", by: "u" } };
      },
    };
    const budget = inMemoryBudget({ limitFor: () => ({}) });
    const settle = vi.spyOn(budget, "settle");
    const svc = new RunService({ dispatcher: selfHosted, store, budget, newId: ids });
    await svc.submit({ tenant: "acme", submittedBy: "u", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).not.toHaveBeenCalled(); // 유저 자기 로그인이 결제 — 워크스페이스 버짓 미차감

    // 대조: 관리형 백엔드 결과(프로비넌스 없음)는 settle 된다.
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).not.toHaveBeenCalled(); // selfHosted 디스패처라 여전히 호출 안 됨

    const managed = new RunService({ dispatcher: okDispatcher, store, budget, newId: ids });
    await managed.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).toHaveBeenCalledTimes(1); // 관리형은 settle
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
    // 연결은 개인 소유 → repoTokenFor 는 owner(제출자 subject)로 resolve("내 연결로 clone").
    const calls: Array<{ owner: string; connectionId: string }> = [];
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      repoTokenFor: async (owner, connectionId) => {
        calls.push({ owner, connectionId });
        return connectionId === "conn-alice" ? "gho_resolved" : undefined;
      },
    });
    const gitCase = (connectionId?: string): EvalCase => ({
      ...CASE,
      env: {
        kind: "repo",
        source: { git: "https://github.com/acme/p.git", ref: "main", ...(connectionId ? { connectionId } : {}) },
      },
    });
    const submit = (c: EvalCase) =>
      svc.submit({ tenant: "acme", submittedBy: "u-alice", harness: { id: "s", version: "0" }, case: c });
    await submit(gitCase("conn-alice")); // 해석됨(내 연결)
    await submit(gitCase("conn-missing")); // 미해석
    await submit(gitCase()); // connectionId 없음(public)
    await submit(CASE); // files 시드(비-git)
    await flush();
    expect(seen).toEqual(["gho_resolved", undefined, undefined, undefined]);
    // connectionId 없는 케이스/비-repo 는 repoTokenFor 를 아예 호출하지 않는다. owner 는 제출자 subject.
    expect(calls).toEqual([
      { owner: "u-alice", connectionId: "conn-alice" },
      { owner: "u-alice", connectionId: "conn-missing" },
    ]);
  });

  it("완료 시 onComplete 콜백을 최신 레코드로 호출(알림 훅)", async () => {
    const seen: Array<{ tenant: string; status: string; id: string }> = [];
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      onComplete: async (tenant, rec) => {
        seen.push({ tenant, status: rec.status, id: rec.id });
      },
    });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toEqual([{ tenant: "acme", status: "succeeded", id: rec.id }]);
  });

  it("디스패치 실패해도 onComplete 는 failed 레코드로 호출된다", async () => {
    const seen: string[] = [];
    const svc = new RunService({
      dispatcher: failDispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      onComplete: async (_t, rec) => {
        seen.push(rec.status);
      },
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toEqual(["failed"]);
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
