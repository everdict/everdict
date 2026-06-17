import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import type { Backend } from "./backend.js";
import { BackendRegistry, Router, buildRegistry } from "./registry.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: AgentJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id, // 어느 백엔드가 처리했는지 표시
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

function job(target?: string): AgentJob {
  return {
    harness: { id: "scripted", version: "0" },
    evalCase: {
      id: "c",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(target ? { placement: { target } } : {}),
    },
  };
}

describe("Router", () => {
  const registry = new BackendRegistry().register("a", new FakeBackend("a")).register("b", new FakeBackend("b"));

  it("placement.target 으로 라우팅한다", async () => {
    expect((await new Router(registry, "a").dispatch(job("b"))).harness).toBe("b");
  });

  it("placement 가 없으면 default 백엔드로 간다", async () => {
    expect((await new Router(registry, "a").dispatch(job())).harness).toBe("a");
  });

  it("미등록 타깃은 에러", async () => {
    await expect(new Router(registry, "a").dispatch(job("missing"))).rejects.toThrow();
  });

  it("target 도 default 도 없으면 에러", async () => {
    await expect(new Router(registry).dispatch(job())).rejects.toThrow();
  });
});

describe("buildRegistry", () => {
  it("설정에서 여러 백엔드를 등록하고 default 를 돌려준다", () => {
    const { registry, defaultTarget } = buildRegistry({
      default: "nomad-a",
      backends: [
        { name: "dev", kind: "local" },
        { name: "nomad-a", kind: "nomad", addr: "http://a:4646", image: "img", runtime: "runsc" },
      ],
    });
    expect(registry.names().sort()).toEqual(["dev", "nomad-a"]);
    expect(defaultTarget).toBe("nomad-a");
  });
});
