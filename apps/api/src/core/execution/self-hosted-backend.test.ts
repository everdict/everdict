import { RunnerHub, type SelfHostedKey } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { SelfHostedBackend } from "./self-hosted-backend.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job: CaseJob = {
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
    hub.complete(key, { jobId: "j1", leaseEpoch: 1 }, result);
    await expect(dispatched).resolves.toMatchObject({
      caseId: "c1",
      provenance: { ranOn: "self-hosted", runner: "laptop", by: "u-alice" },
    });
  });

  // The caller's seal, artifact key and receipt all name the attempt it dispatched. When a requeue hands the
  // job to a second runner, that lease opens its OWN recording attempt — so the backend has to report which
  // one actually ran, or the run seals a recording no execution wrote into (arch-review 41 P0-evidence).
  it("reports the attempt a re-lease actually ran under, so the caller seals that recording and not the one it parked with", async () => {
    let t = 0;
    let opened = 40;
    const hub = new RunnerHub({
      newJobId: () => "j1",
      now: () => t,
      leaseTtlMs: 100,
      openAttempt: async () => ++opened,
    });
    const backend = new SelfHostedBackend(key, hub);
    const seen: number[] = [];
    const dispatched = backend.dispatch(
      { ...job, runId: "evd-run-1", recordingGeneration: 7 },
      { onAttempt: (generation) => seen.push(generation) },
    );

    await hub.leaseWait(key, 0); // the first runner takes it, then goes silent
    t = 201; // past the lease TTL → requeue + re-lease under a new attempt
    const second = await hub.leaseWait(key, 0);
    expect(second?.job.recordingGeneration).toBe(41);
    hub.complete(key, { jobId: "j1", leaseEpoch: 2 }, result);

    await expect(dispatched).resolves.toMatchObject({ caseId: "c1" });
    expect(seen).toEqual([41]); // …and never the 7 this dispatch opened
  });

  it("capacity is total=maxConcurrent, used=0 (parking uses no real resources)", async () => {
    const backend = new SelfHostedBackend(key, new RunnerHub());
    expect(await backend.capacity()).toEqual({ total: 8, used: 0 });
  });

  it("a configured park ceiling raises capacity past the runner queue cap (EVERDICT_RUNNER_MAX_QUEUE wiring)", async () => {
    // Regression: with the default ceiling (8) the Scheduler admitted at most 8 concurrent parks, so a runner
    // queue cap above 8 could NEVER trip — the overflow piled up uncapped in the Scheduler queue instead, and
    // the knob's promised queue-full 429 never fired (live: 800-case flood at cap 200 shed 0).
    const backend = new SelfHostedBackend(key, new RunnerHub(), 200 + 64);
    expect(await backend.capacity()).toEqual({ total: 264, used: 0 });
  });
});
