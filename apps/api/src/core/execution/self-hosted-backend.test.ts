import { RunnerHub, type SelfHostedKey } from "@everdict/application-control";
import type { AgentJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
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
const key: SelfHostedKey = { owner: "u-alice", runnerId: "laptop" };

describe("SelfHostedBackend", () => {
  it("dispatch parks in the hub and, on runner complete, resolves with stamped provenance (ranOn:self-hosted)", async () => {
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

  it("capacity is total=maxConcurrent, used=0 (parking uses no real resources)", async () => {
    const backend = new SelfHostedBackend(key, new RunnerHub());
    expect(await backend.capacity()).toEqual({ total: 8, used: 0 });
  });
});
