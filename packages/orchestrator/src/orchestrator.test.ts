import { BackendRegistry, Router } from "@assay/backends";
import type { Backend } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import { createActivities } from "./activities.js";
import { DirectOrchestrator } from "./orchestrator.js";

class FakeBackend implements Backend {
  constructor(readonly id: string) {}
  async capacity() {
    return { total: 1, used: 0 };
  }
  async dispatch(_job: AgentJob): Promise<CaseResult> {
    return {
      caseId: "c",
      harness: this.id,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

const job: AgentJob = {
  harness: { id: "scripted", version: "0" },
  evalCase: { id: "c", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
};

const router = new Router(new BackendRegistry().register("x", new FakeBackend("x")), "x");

describe("DirectOrchestrator", () => {
  it("Router 로 잡을 실행한다", async () => {
    expect((await new DirectOrchestrator(router).run(job)).harness).toBe("x");
  });
});

describe("createActivities", () => {
  it("dispatchCase 가 Router 를 호출한다 (워커가 등록할 액티비티)", async () => {
    const acts = createActivities(router);
    expect((await acts.dispatchCase(job)).harness).toBe("x");
  });
});
