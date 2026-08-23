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

  it("answers the ROW's handle for a lane that named its own object (arch-review 62)", async () => {
    // K8s decides the Job's name before it creates it and reports it on the invocation, and the earlier
    // version preferred that answer outright. It is not richer — it is the same object described with less:
    // `{tenant, runId, externalJobId, namespace}` and nothing that joins to the ledger. `reserveWork` stored
    // the lane's own named object PLUS the attempt and the verifier coordinate, so the row's handle names
    // exactly what the lane named and can also be looked up.
    //
    // Asserting only the external id here is what let that preference survive a review: both answers agree
    // on it, and the property the receipt actually needs was never checked.
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
    expect(
      invocation.work?.attemptId,
      "the lane's bare handle won, so this verdict cannot be joined to the attempt that produced it",
    ).toBeDefined();
    // …and the coordinate that says which unit this container was judging, which is the other half of what
    // makes a receipt `complete` (see `verifierReceiptOf`).
    expect(invocation.work?.verifier?.caseId).toBe(JOB.caseId);
  });

  it("REFUSES a lane that reports a different container than the one it reserved", async () => {
    // Not reconciled, refused: the alternative is a receipt whose external id and whose attempt row describe
    // two different containers, which is precisely the join this file exists to make trustworthy.
    const { attempts } = await open();
    const liar = async (job: VerifierJob, hooks?: { authority: { reserve: (w: RuntimeWorkRef) => unknown } }) => {
      await hooks?.authority.reserve({
        tenant: job.tenant,
        runId: job.runId,
        externalJobId: "everdict-verify-reserved",
      } as RuntimeWorkRef);
      return {
        planDigest: job.plan.digest,
        workspaceDigest: "sha256:ws",
        work: { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-somewhere-else" },
        scores: SCORES,
      } as VerifierInvocation;
    };

    await expect(verifierOperation({ attempts }, JOB, liar as never)).rejects.toThrow(/different container/i);
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

// ── …AND WHICH EXECUTION WAS JUDGED (arch-review 62 follow-through) ─────────────────────────────────
//
// The previous wave put the JUDGING attempt on the receipt. The judged one was still missing, so a merged
// two-phase case named the container that produced the verdict and not the container that produced the
// evidence — and a reader asking "which execution is this verdict about" had to fall back to the run id,
// which is the LOGICAL execution and the same across a retry, a re-lease and a speculative duplicate.
//
// The coordinate was already in hand: `CaseJob.attemptId` is minted where the ledger row is opened and rides
// the job. It is read through `jobAttemptId`, the helper every other consumer uses, rather than derived a
// second time — a coordinate spelled twice is a coordinate that can differ (see the cancellation that asked
// for `rec.id`).
//
// Seen RED before it travelled, observed:
//   the receipt cannot say which execution it judged: expected undefined to be 'evd-run-r1#g1'
describe("[R62-followup COUNTEREXAMPLE] a verdict names both contributing attempts", () => {
  it("carries the judged execution's attempt beside the judging one", async () => {
    const { attempts } = await open();
    const judged = { ...JOB, agentAttemptId: "evd-run-r1#g1" } as unknown as VerifierJob;
    const invocation = await verifierOperation({ attempts }, judged, nomadShaped as never);

    expect(invocation.agentAttemptId, "the receipt cannot say which execution it judged").toBe("evd-run-r1#g1");
    // …and the one that produced the verdict is still there, or this has traded one half for the other.
    expect(invocation.work?.attemptId, "the judging attempt was lost").toBeDefined();
  });

  it("says nothing when the job could not name one", async () => {
    // A deployment with no ledger opens no row, so there is no attempt to name. An invented id would be
    // worse than an absent one: it would join to nothing while looking like provenance.
    const { attempts } = await open();
    const invocation = await verifierOperation({ attempts }, JOB, nomadShaped as never);
    expect(invocation.agentAttemptId).toBeUndefined();
  });
});
