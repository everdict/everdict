import { RunnerHub, type SelfHostedKey } from "@everdict/application-control";
import { runExecutionId } from "@everdict/contracts";
import type { AttemptRef, CaseJob, CaseResult } from "@everdict/contracts";
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
    const seen: AttemptRef[] = [];
    const dispatched = backend.dispatch(
      { ...job, runId: "evd-run-1", recordingGeneration: 7 },
      { onAttempt: (attempt) => seen.push(attempt) },
    );

    await hub.leaseWait(key, 0); // the first runner takes it, then goes silent
    t = 201; // past the lease TTL → requeue + re-lease under a new attempt
    const second = await hub.leaseWait(key, 0);
    expect(second?.job.recordingGeneration).toBe(41);
    hub.complete(key, { jobId: "j1", leaseEpoch: 2 }, result);

    await expect(dispatched).resolves.toMatchObject({ caseId: "c1" });
    // …and never the 7 this dispatch opened. The RECORDING-ONLY composition (no attempt ledger wired) hands
    // back a bare generation, so the ref's name is the coordinate that generation spells — the one documented
    // fallback left (attemptRefOf), and exact: `open` mints the ordinal the row's id is built from.
    expect(seen).toEqual([
      { attemptId: "evd-run-1#g41", executionId: runExecutionId("1"), recording: { generation: 41 } },
    ] satisfies AttemptRef[]);
  });

  // …and the lane the generation channel could never describe (arch-review 52): a re-lease whose RECORDING
  // claim was refused has a ledger row and no fence, so the old hook — which fired only on a generation —
  // stayed silent about a second physical execution and left the caller naming the attempt it had parked with.
  it("reports an unisolated re-lease by name, where there is no recording generation to report", async () => {
    let t = 0;
    const hub = new RunnerHub({
      newJobId: () => "j1",
      now: () => t,
      leaseTtlMs: 100,
      // openPhysicalAttempt's fail-closed shape: the row exists, the fence does not.
      openAttempt: async () => ({ attemptId: "evd-run-1#g2" }),
    });
    const backend = new SelfHostedBackend(key, hub);
    const seen: AttemptRef[] = [];
    const dispatched = backend.dispatch(
      { ...job, runId: "evd-run-1", recordingGeneration: 1, attemptId: "evd-run-1#g1" },
      { onAttempt: (attempt) => seen.push(attempt) },
    );

    await hub.leaseWait(key, 0);
    t = 201;
    const second = await hub.leaseWait(key, 0);
    expect(second?.job.attemptId).toBe("evd-run-1#g2");
    expect(second?.job.recordingGeneration).toBeUndefined();
    hub.complete(key, { jobId: "j1", leaseEpoch: 2 }, result);

    await expect(dispatched).resolves.toMatchObject({ caseId: "c1" });
    expect(seen).toEqual([{ attemptId: "evd-run-1#g2", executionId: runExecutionId("1") }] satisfies AttemptRef[]);
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
