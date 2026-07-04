import { BackendRegistry, type Dispatcher } from "@assay/backends";
import type { AgentJob, CaseResult, RuntimeSpec } from "@assay/core";
import { InMemoryRuntimeRegistry } from "@assay/registry";
import { describe, expect, it, vi } from "vitest";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};

// inner(Scheduler 대역) — 받은 잡을 기록하고 result 반환.
function innerSpy() {
  const seen: AgentJob[] = [];
  const inner: Dispatcher = {
    async dispatch(job) {
      seen.push(job);
      return result;
    },
  };
  return { inner, seen };
}

const job = (target?: string): AgentJob => ({
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    ...(target ? { placement: { target } } : {}),
  },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});

const localRuntime: RuntimeSpec = { kind: "local", id: "mylocal", version: "1.0.0", tags: [] };

describe("RuntimeDispatcher", () => {
  it("placement.target 이 테넌트 Runtime 이면: 백엔드를 빌드/등록하고 target 을 rt:tenant:id@ver 로 재작성", async () => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", localRuntime);
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor: async () => ({}) });

    await d.dispatch(job("mylocal"));
    expect(backends.has("rt:acme:mylocal@1.0.0")).toBe(true); // 빌드+등록됨
    expect(seen[0]?.evalCase.placement?.target).toBe("rt:acme:mylocal@1.0.0"); // target 재작성

    // 재호출 시 재빌드 안 함(이미 등록)
    const built = backends.get("rt:acme:mylocal@1.0.0");
    await d.dispatch(job("mylocal"));
    expect(backends.get("rt:acme:mylocal@1.0.0")).toBe(built);
  });

  it("target 이 이미 글로벌 백엔드면 그대로 통과(런타임 해석 안 함)", async () => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    const resolve = vi.spyOn(runtimes, "get");
    // 글로벌 백엔드 "local" 가 이미 있다고 가정(BackendRegistry.has 만 보면 됨)
    backends.register("local", {
      id: "local",
      capacity: async () => ({ total: 1, used: 0 }),
      dispatch: async () => result,
    });
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor: async () => ({}) });
    await d.dispatch(job("local"));
    expect(seen[0]?.evalCase.placement?.target).toBe("local"); // 그대로
    expect(resolve).not.toHaveBeenCalled();
  });

  it("target 없으면 그대로 통과(기본 백엔드 정책)", async () => {
    const { inner, seen } = innerSpy();
    const d = new RuntimeDispatcher({
      inner,
      backends: new BackendRegistry(),
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
    });
    await d.dispatch(job());
    expect(seen[0]?.evalCase.placement?.target).toBeUndefined();
  });

  it("secretsFor 결과를 백엔드 secretEnv 로 전달(테넌트 시크릿 주입)", async () => {
    const { inner } = innerSpy();
    const backends = new BackendRegistry();
    const runtimes = new InMemoryRuntimeRegistry();
    await runtimes.register("acme", localRuntime);
    const secretsFor = vi.fn(async () => ({ ANTHROPIC_API_KEY: "sk" }));
    const d = new RuntimeDispatcher({ inner, backends, runtimes, secretsFor });
    await d.dispatch(job("mylocal"));
    expect(secretsFor).toHaveBeenCalledWith("acme");
  });

  // self:<runnerId> — 개인 소유 셀프호스티드 러너 라우팅(Slice 2: 소유 확인 + 백엔드 빌드/라우팅).
  const selfJob = (target: string, submittedBy?: string): AgentJob => ({
    ...job(target),
    ...(submittedBy ? { submittedBy } : {}),
  });
  const selfDeps = (caps: string[] | undefined) => {
    // caps: undefined = 미소유(404), 배열 = 소유 + 그 러너의 capabilities.
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const resolveSelfRunner = vi.fn(async () => caps);
    const buildSelfHostedBackend = vi.fn(() => stub);
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
      resolveSelfRunner,
      buildSelfHostedBackend,
    });
    return { d, seen, backends, resolveSelfRunner, buildSelfHostedBackend };
  };

  // service 하니스 잡(harnessSpec.kind==="service") — docker capability 게이트 검증용.
  const selfServiceJob = (target: string, submittedBy: string): AgentJob => ({
    ...selfJob(target, submittedBy),
    harnessSpec: {
      kind: "service",
      id: "bu",
      version: "1",
      services: [],
      dependencies: [],
      frontDoor: { service: "s", submit: "POST /runs" },
      traceSource: { kind: "mlflow", endpoint: "http://x" },
    },
  });

  it("self:<runnerId> 가 제출자 소유면: self:owner:runnerId 백엔드를 빌드/등록하고 그리로 라우팅", async () => {
    const { d, seen, backends, resolveSelfRunner } = selfDeps(["repo"]);
    await d.dispatch(selfJob("self:dev-laptop", "u-alice"));
    expect(resolveSelfRunner).toHaveBeenCalledWith("u-alice", "dev-laptop");
    expect(backends.has("self:u-alice:dev-laptop")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:dev-laptop");
  });

  it("self: 러너가 미소유면 NOT_FOUND(남의 러너 타깃 거부 — 존재 누설 없음)", async () => {
    const { d, seen } = selfDeps(undefined);
    await expect(d.dispatch(selfJob("self:someone-else", "u-alice"))).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(seen).toHaveLength(0); // inner 로 안 감
  });

  it("self: 인데 submittedBy(소유자) 미상이면 NOT_FOUND", async () => {
    const { d } = selfDeps(["repo"]);
    await expect(d.dispatch(selfJob("self:dev-laptop"))).rejects.toMatchObject({ status: 404 });
  });

  it("service 하니스인데 러너에 docker capability 없으면 BAD_REQUEST(실행 전 차단)", async () => {
    const { d, seen } = selfDeps(["repo"]); // docker 없음
    await expect(d.dispatch(selfServiceJob("self:dev-laptop", "u-alice"))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    expect(seen).toHaveLength(0); // 실행 전 차단 — inner 로 안 감
  });

  it("service 하니스 + docker capability 있으면 라우팅된다", async () => {
    const { d, seen, backends } = selfDeps(["repo", "docker", "browser"]);
    await d.dispatch(selfServiceJob("self:dev-laptop", "u-alice"));
    expect(backends.has("self:u-alice:dev-laptop")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:dev-laptop");
  });

  // self:ws:<runnerId> — 워크스페이스-공유 러너. 소유자를 제출자가 아닌 잡의 tenant(ws:<tenant>)에서 파생하므로
  // 그 워크스페이스 멤버라면 누구든(submittedBy 무관) 타깃한다. 팀 빌드서버/CI 러너 공유용.
  it("self:ws:<runnerId> 는 owner=ws:<tenant> 로 해석(멤버 누구나 — submittedBy 불필요)", async () => {
    const { d, seen, backends, resolveSelfRunner } = selfDeps(["git", "docker"]);
    await d.dispatch(selfJob("self:ws:team-builder")); // submittedBy 없음
    expect(resolveSelfRunner).toHaveBeenCalledWith("ws:acme", "team-builder");
    expect(backends.has("self:ws:acme:team-builder")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:team-builder");
  });

  it("self:ws: 인데 그 워크스페이스에 공유 러너 없으면 NOT_FOUND(크로스 워크스페이스 차단)", async () => {
    const { d, seen, resolveSelfRunner } = selfDeps(undefined);
    await expect(d.dispatch(selfJob("self:ws:nope"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(resolveSelfRunner).toHaveBeenCalledWith("ws:acme", "nope"); // 항상 잡의 tenant 로만 조회 — 남의 ws 못 봄
    expect(seen).toHaveLength(0);
  });

  // self:ws(러너 id 없이) — 워크스페이스 풀. 특정 러너 대신 그 워크스페이스의 아무 러너나(capability 충족) 가져간다.
  const poolDeps = (hasRunners: boolean) => {
    const { inner, seen } = innerSpy();
    const backends = new BackendRegistry();
    const stub = { id: "stub", capacity: async () => ({ total: 1, used: 0 }), dispatch: async () => result };
    const poolHasRunners = vi.fn(async () => hasRunners);
    const buildSelfHostedBackend = vi.fn(() => stub);
    const d = new RuntimeDispatcher({
      inner,
      backends,
      runtimes: new InMemoryRuntimeRegistry(),
      secretsFor: async () => ({}),
      resolveSelfRunner: async () => undefined,
      poolHasRunners,
      buildSelfHostedBackend,
    });
    return { d, seen, backends, poolHasRunners };
  };

  it("self:ws(id 없음) → 워크스페이스 풀 백엔드 self:ws:acme:* 로 라우팅(아무 러너나 드레인)", async () => {
    const { d, seen, backends, poolHasRunners } = poolDeps(true);
    await d.dispatch(selfJob("self:ws"));
    expect(poolHasRunners).toHaveBeenCalledWith("ws:acme");
    expect(backends.has("self:ws:acme:*")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:ws:acme:*");
  });

  it("self:ws 인데 워크스페이스에 러너가 하나도 없으면 NOT_FOUND", async () => {
    const { d, seen } = poolDeps(false);
    await expect(d.dispatch(selfJob("self:ws"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });

  // self(러너 id 없이) — 개인 풀. owner=제출자(submittedBy). 내 러너 아무거나(여러 프로세스/머신을 한 풀에).
  it("self(id 없음) → 개인 풀 백엔드 self:<subject>:* 로 라우팅(owner=제출자)", async () => {
    const { d, seen, backends, poolHasRunners } = poolDeps(true);
    await d.dispatch(selfJob("self", "u-alice"));
    expect(poolHasRunners).toHaveBeenCalledWith("u-alice"); // 워크스페이스가 아니라 제출자
    expect(backends.has("self:u-alice:*")).toBe(true);
    expect(seen[0]?.evalCase.placement?.target).toBe("self:u-alice:*");
  });

  it("self 인데 제출자(submittedBy) 미상이면 NOT_FOUND(개인 풀은 인증 필요)", async () => {
    const { d, seen } = poolDeps(true);
    await expect(d.dispatch(selfJob("self"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });

  it("self 인데 내 러너가 하나도 없으면 NOT_FOUND", async () => {
    const { d, seen } = poolDeps(false);
    await expect(d.dispatch(selfJob("self", "u-alice"))).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(seen).toHaveLength(0);
  });
});
