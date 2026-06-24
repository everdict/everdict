import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import { RunnerHub, type SelfHostedKey } from "./runner-hub.js";
import { SelfHostedBackend } from "./self-hosted-backend.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job: AgentJob = {
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
};
const key: SelfHostedKey = { tenant: "acme", owner: "u-alice", runnerId: "laptop" };

describe("SelfHostedBackend", () => {
  it("dispatch 는 hub 에 파킹하고, 러너 complete 시 프로비넌스(ranOn:self-hosted)를 스탬프해 resolve", async () => {
    const hub = new RunnerHub({ newJobId: () => "j1" });
    const backend = new SelfHostedBackend(key, hub);
    const dispatched = backend.dispatch(job);
    expect(hub.lease(key)?.jobId).toBe("j1");
    hub.complete(key, "j1", result);
    await expect(dispatched).resolves.toMatchObject({
      caseId: "c1",
      provenance: { ranOn: "self-hosted", runner: "laptop", by: "u-alice" },
    });
  });

  it("capacity 는 total=maxConcurrent, used=0(파킹은 실자원 0)", async () => {
    const backend = new SelfHostedBackend(key, new RunnerHub());
    expect(await backend.capacity()).toEqual({ total: 8, used: 0 });
  });
});
