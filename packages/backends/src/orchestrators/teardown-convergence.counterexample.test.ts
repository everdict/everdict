import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { classifyFailure } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { NomadBackend } from "./nomad.js";

// ── ACCEPTED IS NOT GONE, AND THE RETRY DEPENDS ON THE DIFFERENCE (arch-review 64 P1) ────────────────
//
// The post-start failure path deletes the exact job and reads the DELETE's own status. A Nomad DELETE
// answering 2xx means the job is marked STOPPED — its allocation keeps running for the kill timeout, which is
// what this adapter's `probeWork` says in as many words — and the error it then rethrows is classified
// retryable, so `runSuite` re-dispatched while the old allocation was still terminating.
//
// Two allocations of one case, overlapping: the double-spend the placement protocol exists to prevent,
// arriving through the FAILURE path while the cancellation path had been converging on verified absence for
// two reviews. One verifier, both paths (rule `protocol` L5) — this is the failure path learning it.
//
// Seen RED before the read-back, observed:
//   a dispatch whose job may still be running was reported as retryable: expected true to be false

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, tags: [] },
  }) as unknown as CaseJob;

const AUTHORITY = {
  reserve: async (work: RuntimeWorkRef) => ({ attemptId: "a1", work, persistedAt: new Date(0).toISOString() }),
  activate: async () => ({ kind: "activate" as const }),
};

// A Nomad that registers, starts, then fails the dispatch — and answers the teardown's questions the way the
// scenario under test does. `afterStop` is what the cluster reports once the DELETE has been accepted.
function nomadHttp(afterStop: "gone" | "still-running" | "unreadable") {
  const registered = new Set<string>();
  return {
    events: [] as string[],
    request: async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/v1/jobs") {
        const job = (body as { Job: { ID: string; TaskGroups: Array<{ Count: number }> } }).Job;
        registered.add(job.ID);
        const inert = (job.TaskGroups[0]?.Count ?? 0) === 0;
        return { status: 200, text: JSON.stringify({ JobModifyIndex: inert ? 7 : 8 }) };
      }
      if (method === "DELETE") {
        // ACCEPTED — the job is marked stopped. Whether the allocation is gone is a different question.
        if (afterStop === "gone") registered.clear();
        return { status: 200, text: "{}" };
      }
      if (method === "GET" && path.startsWith("/v1/jobs")) {
        if (afterStop === "unreadable") return { status: 500, text: "the job listing is unavailable" };
        return { status: 200, text: JSON.stringify([...registered].map((ID) => ({ ID, Namespace: "default" }))) };
      }
      if (method === "GET" && path.startsWith("/v1/job/")) {
        // The job's own status: `dead` is convergence, anything else is an allocation that may still run.
        return { status: 200, text: JSON.stringify({ Status: afterStop === "gone" ? "dead" : "running" }) };
      }
      // Anything else fails the dispatch AFTER the job has been started, which is the window under test.
      throw new Error("the allocation could not be polled");
    },
  };
}

const dispatchFailing = async (afterStop: "gone" | "still-running" | "unreadable") => {
  const http = nomadHttp(afterStop);
  const err = await new NomadBackend({ addr: "http://nomad:4646", image: "runner:1", http } as never)
    .dispatch(JOB(), { authority: AUTHORITY })
    .then(() => undefined)
    .catch((e: unknown) => e);
  return err;
};

describe("[R64 COUNTEREXAMPLE] a failed dispatch converges before it is retried", () => {
  it("REFUSES to be retryable while the allocation may still be running", async () => {
    const err = await dispatchFailing("still-running");
    expect(err, "the dispatch did not fail, so this file measured nothing").toBeDefined();

    const failure = classifyFailure(err, "run");
    expect(failure.retryable, "a dispatch whose job may still be running was reported as retryable").toBe(false);
    // …and the failure still says what FAILED. The first draft threw a fresh error about the cleanup and took
    // the original's code, message and evidence with it — the placement verdict, the task-event cause, the
    // log tail — which is the evidence this path exists to capture before the job is purged.
    expect(failure.code).not.toBe("INTERNAL");
  });

  it("REFUSES on an unreadable probe too — asking and learning nothing stopped nothing", async () => {
    // A listing that failed is not an empty cluster (rule `protocol` L2), and here the collapse would be paid
    // for in overlapping compute rather than in a wrong number.
    const failure = classifyFailure(await dispatchFailing("unreadable"), "run");
    expect(failure.retryable, "a probe that learned nothing was read as convergence").toBe(false);
  });

  it("stays RETRYABLE when the job is confirmed gone", async () => {
    // The control, and the one that keeps this from becoming "every dispatch failure is fatal". A teardown
    // that converged owes nothing, and the original failure — a poll that could not reach the allocation — is
    // exactly the transient the batch's retry exists for.
    const failure = classifyFailure(await dispatchFailing("gone"), "run");
    expect(failure.retryable, "a converged teardown lost the retry its failure was entitled to").toBe(true);
  });

  it("carries the original failure's words either way", async () => {
    // An operator reading `TEARDOWN_UNCONVERGED` still needs to know what failed in the first place — the
    // cleanup is the second fact, not a replacement for the first.
    // The exact words belong to whichever step failed first, and this fixture's poll fails a little earlier
    // than its `throw` — which is the point: the cause is carried VERBATIM rather than replaced, so it says
    // whatever really happened.
    const err = await dispatchFailing("still-running");
    expect((err as { extra?: { teardown?: string } })?.extra?.teardown).toBe("unconverged");
    // The message is the DISPATCH's own, not a sentence about the cleanup.
    expect((err as Error).message, "the teardown replaced the dispatch failure instead of marking it").not.toContain(
      "could not be confirmed stopped",
    );
  });
});
