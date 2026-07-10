import { BackendRegistry, Router } from "@everdict/backends";
import type { Backend } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/contracts";
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
  it("runs a job via the Router", async () => {
    expect((await new DirectOrchestrator(router).run(job)).harness).toBe("x");
  });
});

describe("createActivities", () => {
  it("dispatchCase calls the Router (the activity the worker registers)", async () => {
    const acts = createActivities(router);
    expect((await acts.dispatchCase(job)).harness).toBe("x");
  });
});
