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
});
