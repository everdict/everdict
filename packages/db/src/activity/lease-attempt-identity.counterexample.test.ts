import {
  type EnqueueResult,
  InMemoryExecutionAttemptStore,
  type OpenLeaseAttempt,
  type SelfHostedKey,
  StoreRunnerHub,
} from "@everdict/application-control";
import { runExecutionId, storedExecutionId } from "@everdict/contracts";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRunnerJobStore } from "./runner-job-store.js";

// ── THE ATTEMPT THAT RAN IS THE ONE THE CALLER IS TOLD ABOUT (arch-review 52, Wave 1) ───────────────
//
// A re-lease is a new physical execution, so it opens its own attempt and the parking replica has to learn
// WHICH one — otherwise the result it commits is filed under the attempt a requeue abandoned. `EnqueueResult`
// carries exactly one identity channel for that: `generation`, read off the row.
//
// The generation is the RECORDING fence, and it is absent precisely when the recording claim was REFUSED —
// the `unisolated` attempt, which has a ledger row and no generation (openPhysicalAttempt). So on the one
// lane where the ledger row is the only thing that exists, the reply carries nothing, `onAttempt` never
// fires, and the caller keeps naming the DISPATCH's attempt: the receipt, the artifacts and the committed row
// all say attempt A about work that attempt B did.
//
// The invariant: the coordinate that comes back names the execution that actually ran, generation or not.

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job = (id: string): CaseJob => ({
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});
const keyA: SelfHostedKey = { owner: "u-alice", runnerId: "laptop" };

let seq = 0;
const hubOpts = (over: Record<string, unknown> = {}) => ({
  pollMs: 2,
  newJobId: () => `j-ce8-${seq++}`,
  queueTimeoutMs: 10_000,
  ...over,
});

// [WAVE-1 COUNTEREXAMPLE #8] Was RED as of 02a3e15e: `AssertionError: expected undefined to be 'evd-run-1#g2'
// // Object.is equality` — EnqueueResult carried only `generation`, which an unisolated re-lease does not have, so
// the parking replica fell back to the dispatch's attempt A. GREEN since wave 1: the reply carries `attemptId`,
// read off the row the mint restamped (RunnerJobOutcome.attemptId).
describe("a self-hosted re-lease reports the attempt it actually ran, even with no recording fence", () => {
  it("names the re-lease's own attempt when its recording claim was refused (unisolated)", async () => {
    // Given a job parked under the attempt the DISPATCH opened (A), with its recording generation
    const store = new InMemoryRunnerJobStore();
    const ledger = new InMemoryExecutionAttemptStore();
    const dispatched = await ledger.open({ executionId: runExecutionId("1"), tenant: "acme" });
    await ledger.transition(dispatched.attemptId, "executing");

    // …and a claim-lane seam whose RECORDING claim is refused: the ledger row is opened and marked unisolated,
    // and no generation comes back (openPhysicalAttempt's fail-closed shape).
    const openLeaseAttempt: OpenLeaseAttempt = async ({ job: leased, leaseEpoch, attempts, prior }) => {
      const attemptStore = attempts ?? ledger;
      if (prior !== undefined)
        await attemptStore.transition(prior, "superseded", {
          error: { code: "LEASE_SUPERSEDED", message: "re-leased to another runner" },
        });
      const { runId, tenant } = leased;
      if (runId === undefined || tenant === undefined) throw new Error("the fixture job carries both");
      const opened = await attemptStore.open({ executionId: storedExecutionId(runId), tenant });
      await attemptStore.markUnisolated(opened.attemptId);
      return {
        attemptId: opened.attemptId, // …the row exists; the fence does not
        markExecuting: async () => {
          await attemptStore.transition(opened.attemptId, "executing", { leaseEpoch });
        },
      };
    };
    // leaseTtlMs 0 → the second claim is a genuine RE-lease (the first is requeued first).
    const hub = new StoreRunnerHub(store, hubOpts({ leaseTtlMs: 0, openLeaseAttempt }));
    const parked = hub.enqueue(keyA, {
      ...job("c1"),
      runId: "evd-run-1",
      recordingGeneration: dispatched.generation,
      attemptId: dispatched.attemptId,
    });

    await hub.leaseWait(keyA, 200, ["repo"]); // epoch 1 — runs the dispatch's attempt
    const second = await hub.leaseWait(keyA, 200, ["repo"]); // epoch 2 — a second physical execution
    if (!second) throw new Error("expected the re-lease");
    // The job the runner holds names B and carries no generation — an execution that is recorded but unfenced.
    expect(second.job.attemptId).toBe("evd-run-1#g2");
    expect(second.job.recordingGeneration).toBeUndefined();

    // When that runner completes the job
    expect(await hub.complete(keyA, second.attempt, result)).toBe(true);

    // Then the parking replica is told WHICH attempt produced this result. `generation` cannot say it here —
    // there is none — so the answer has to carry the name, and without it every downstream coordinate (the
    // commit receipt, the attempt ledger's terminal stamp, the artifact key) files B's work under A.
    const enqueued: EnqueueResult = await parked;
    expect(enqueued.attemptId).toBe("evd-run-1#g2");
    expect(enqueued.generation).toBeUndefined(); // …the channel that existed before is empty exactly when it is needed

    // …and the ledger already agrees about which execution was live: A ended, B ran.
    expect((await ledger.list(runExecutionId("1"))).map((a) => [a.attemptId, a.state, a.unisolated])).toEqual([
      ["evd-run-1#g1", "superseded", false],
      ["evd-run-1#g2", "executing", true],
    ]);
  });
});
