import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";
import { BackendRegistry } from "./registry.js";
import { Router } from "./router.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: CaseJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id, // marks which backend handled it
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

function job(target?: string): CaseJob {
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

  it("routes by placement.target", async () => {
    expect((await new Router(registry, "a").dispatch(job("b"))).harness).toBe("b");
  });

  it("goes to the default backend when there's no placement", async () => {
    expect((await new Router(registry, "a").dispatch(job())).harness).toBe("a");
  });

  it("an unregistered target is an error", async () => {
    await expect(new Router(registry, "a").dispatch(job("missing"))).rejects.toThrow();
  });

  it("no target and no default is an error", async () => {
    await expect(new Router(registry).dispatch(job())).rejects.toThrow();
  });
});
