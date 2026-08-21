import type { RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { verifierOperation } from "./verifier-operation.js";

// ── A VERDICT SAYS WHERE IT WAS PRODUCED (arch-review 60 P1-provenance) ──────────────────────────────
//
// `VerifierReceipt.complete` is the one signal a consumer has for "this verdict's account is whole", and it
// requires two things: a resolved image provenance and `invocation.work` — the exact external object that
// produced the verdict.
//
// The K8s lane names its Job before it creates it, so it can answer. The Nomad lane cannot: its job id is
// minted inside `dispatch`, and `dispatchVerifier` builds its return value from what the poll saw. So a
// digest-pinned Nomad verifier that ran perfectly produced a receipt reading INCOMPLETE — partial judgment
// evidence, an `execution_world` that cannot verify, and a replay unable to say which Nomad job made the
// verdict. Not a wrong answer; a permanently weaker one, on a whole lane.
//
// The handle was never missing. It is exactly what the reservation persisted one frame earlier, and this
// operation is the frame that holds both. Merged here rather than in each lane, because a lane that does not
// know its own id yet cannot be asked to report it — and because the store's answer is the canonical one:
// an idempotent re-reservation hands back the handle already on the row, which is the object this verdict
// belongs to (rule `protocol` L3).
//
// Seen RED before the merge, observed:
//   a verdict cannot say which external object produced it: expected undefined to be defined

const JOB: VerifierJob = {
  runId: "evd-run-r1",
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
} as unknown as VerifierJob;

const SCORES = [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }];

// A lane that reserves through the hook and answers WITHOUT a work handle — the Nomad shape.
const nomadShaped = async (job: VerifierJob, hooks?: { authority: { reserve: (w: RuntimeWorkRef) => unknown } }) => {
  await hooks?.authority.reserve({
    tenant: job.tenant,
    runId: job.runId,
    externalJobId: "everdict-verify-c1-9f2a",
  } as RuntimeWorkRef);
  return {
    planDigest: job.plan.digest,
    workspaceDigest: "sha256:ws",
    scores: SCORES,
  } as VerifierInvocation;
};

const open = async () => {
  const attempts = new InMemoryExecutionAttemptStore();
  return { attempts };
};

describe("[R60 COUNTEREXAMPLE] a verifier invocation carries the object that produced it", () => {
  it("fills in the handle the reservation persisted when the lane cannot name it", async () => {
    const { attempts } = await open();
    const invocation = await verifierOperation({ attempts }, JOB, nomadShaped as never);

    expect(invocation.work, "a verdict cannot say which external object produced it").toBeDefined();
    expect(invocation.work?.externalJobId).toBe("everdict-verify-c1-9f2a");
    // …and it is the row's own handle, so a receipt joins the verdict to the physical attempt without
    // re-deriving anything.
    expect(invocation.work?.attemptId).toBeDefined();
  });

  it("does NOT overwrite a lane that named its own object", async () => {
    // K8s decides the Job's name before it creates it and reports it on the invocation. That answer is the
    // lane's own observation and wins — the reservation is the fallback, not a correction.
    const { attempts } = await open();
    const k8sShaped = async (job: VerifierJob, hooks?: { authority: { reserve: (w: RuntimeWorkRef) => unknown } }) => {
      const named = { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-named" };
      await hooks?.authority.reserve(named as RuntimeWorkRef);
      return {
        planDigest: job.plan.digest,
        workspaceDigest: "sha256:ws",
        work: named,
        scores: SCORES,
      } as VerifierInvocation;
    };

    const invocation = await verifierOperation({ attempts }, JOB, k8sShaped as never);
    expect(invocation.work?.externalJobId).toBe("everdict-verify-named");
  });

  it("still answers the verdict itself — the merge must not cost the scores", async () => {
    // The control: every assertion above would also pass if `verifierOperation` had started returning
    // something empty.
    const { attempts } = await open();
    const invocation = await verifierOperation({ attempts }, JOB, nomadShaped as never);
    expect(invocation.scores).toHaveLength(1);
    expect(invocation.planDigest).toBe("sha256:plan");
  });
});
