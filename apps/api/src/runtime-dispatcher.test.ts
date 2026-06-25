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
});
