import type { ExecutionAttemptRecord, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { verifierOperation } from "./verifier-operation.js";

// ── THE TERMINAL CAS IS THE RE-PROOF, NOT A NOTIFICATION (arch-review 58 P1) ─────────────────────────
//
// `verifierOperation` settles its row with
//
//     await attempts.transition(attemptId, "committed");
//
// and drops the answer. `transition` is a CONDITIONAL write — it returns whether the row moved — and the one
// way it returns `false` here is the way that matters: something else already made this attempt terminal
// while the verifier was judging. In practice that something is a cancellation, which puts the reservation
// into `revoked` precisely so the holder has something to fail against.
//
// So the verdict was produced by an attempt whose authority had been taken back, and the code returned it as
// a measurement. That is rule `protocol` L1's second half almost verbatim: a proof has a lifetime, and the
// write that records the outcome is where the effect re-proves the proof is still valid. Here the re-proof
// exists, is performed, answers "no" — and is thrown away.
//
// The honest outcome is not a number. `withVerifierPass` turns a throw into `tests_pass: unmeasured`, which
// says the case was not judged; a `1` from a revoked attempt says it passed.
//
// The same applies to a settle that could not be read back at all (rule `protocol` L2): "the ledger did not
// answer" is not "the row settled".
//
// RED as of 061d5ace, observed:
//   expected [Function] to throw an error — a revoked attempt's verdict was returned as a measurement

const JOB: VerifierJob = {
  runId: "evd-sc-1-c1-t0",
  tenant: "acme",
  caseId: "c1",
  scorecardId: "sc-1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
} as unknown as VerifierJob;

const INVOCATION: VerifierInvocation = {
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
} as unknown as VerifierInvocation;

describe("[R58 COUNTEREXAMPLE] a verdict is only a measurement if its attempt settled", () => {
  it("REFUSES the verdict of an attempt a cancellation revoked mid-judgment", async () => {
    const attempts = new InMemoryExecutionAttemptStore();

    await expect(
      verifierOperation({ attempts }, JOB, async (_job, hooks) => {
        const intent = await hooks.authority.reserve({ tenant: "acme", runId: JOB.runId, externalJobId: "verify-1" });
        // The cancellation lands while the verifier container is judging — which is the whole window this
        // state exists for.
        await attempts.revokeReservation(intent.attemptId);
        return INVOCATION;
      }),
      "a revoked attempt's verdict was returned as a measurement",
    ).rejects.toThrow(/revok|settle/i);
  });

  it("returns the verdict when the attempt really did settle", async () => {
    // The refusal above must not become a refusal of the ordinary path.
    const attempts = new InMemoryExecutionAttemptStore();
    const invocation = await verifierOperation({ attempts }, JOB, async (_job, hooks) => {
      await hooks.authority.reserve({ tenant: "acme", runId: JOB.runId, externalJobId: "verify-1" });
      return INVOCATION;
    });
    expect(invocation.scores).toHaveLength(1);
    const rows = await attempts.listForScorecard("sc-1");
    expect(rows[0]?.state).toBe("committed");
  });

  it("REFUSES when the ledger cannot say whether it settled — unknown is not success", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const blind = new Proxy(attempts, {
      get(target, prop, receiver) {
        if (prop === "transition") return async () => false;
        if (prop === "list")
          return async (): Promise<ExecutionAttemptRecord[]> => {
            throw new Error("ledger unreadable");
          };
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      verifierOperation({ attempts: blind }, JOB, async (_job, hooks) => {
        await hooks.authority.reserve({ tenant: "acme", runId: JOB.runId, externalJobId: "verify-1" });
        return INVOCATION;
      }),
      "an unreadable ledger was treated as a settled attempt",
    ).rejects.toThrow();
  });

  it("still runs with NO ledger at all — there is no proof to re-check", async () => {
    // A deployment with no ledger judged fine before any of this, and must keep doing so: the refusal above
    // is about a proof that was taken back, not about the absence of one.
    const invocation = await verifierOperation({}, JOB, async (_job, hooks) => {
      await hooks.authority.reserve({ tenant: "acme", runId: JOB.runId, externalJobId: "verify-1" });
      return INVOCATION;
    });
    expect(invocation.scores).toHaveLength(1);
  });
});
