import type { RuntimeWorkRef, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend } from "./k8s.js";

// ── A SPECIALIZED LANE LOSES WHICHEVER TRANSITION IS ADDED NEXT (arch-review 59 P0-verifier) ────────
//
// `dispatchVerifier` is the same protocol as `dispatch` with a different payload: reserve the work,
// re-present that reservation at the moment the external object is born, submit, parse. The K8s one is
// written out longhand, and it does
//
//     authority.reserve(work)
//     → api.applyJob(...)
//
// with no activation between them. Nothing type-checks "the same sequence", so when arch-review 58 added the
// re-presentation to the shared path, this copy simply did not get it — silently, and while every test passed.
//
// What that costs is the exact race the activation exists to close, one lane over:
//
//     verifier reserves
//     → parent cancelled; teardown kills the ledger's work, probes it ABSENT (no object yet),
//       settles every child, COMPLETES
//     → the paused verifier wakes and creates the Job
//
// A cancellation that certified zero, followed by a birth. The Nomad verifier reuses `dispatch` and therefore
// kept the step, which is the whole argument: the variance between lanes belongs in a parameter, not in a
// second body.
//
// Seen RED before the activation was added, observed:
//   the k8s verifier created its Job without re-presenting the reservation: expected [ 'reserve', 'apply' ]
//   to deeply equal [ 'reserve', 'activate', 'apply' ]

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

// A cluster that records the order of everything it is asked to do, and answers a finished Job.
function world(order: string[]) {
  return {
    async ensureNamespace() {},
    async patchOwnedByJob() {},
    async applyJob() {
      order.push("apply");
      // Stops here on purpose: what this file is about is the ORDER up to the object's birth, and letting the
      // poll run would only add a fake cluster's lifecycle to a test that does not ask about it.
      throw new Error("stop after the birth");
    },
    async jobStatus() {
      return { status: "succeeded" as const };
    },
    async podLogs() {
      return `__EVERDICT_VERIFIER_RESULT__ ${JSON.stringify({
        runId: JOB.runId,
        caseId: JOB.caseId,
        planDigest: "sha256:plan",
        workspaceDigest: "sha256:ws",
        scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
      })}`;
    },
    async deleteJob() {
      return { status: "stopped" as const };
    },
    async podsForJob() {
      return [];
    },
    async namespaceEvents() {
      return [];
    },
  };
}

describe("[R59 COUNTEREXAMPLE] the k8s verifier re-presents its reservation before the Job exists", () => {
  it("activates between reserving and applying", async () => {
    const order: string[] = [];
    const api = world(order);
    const backend = new K8sBackend({ image: "runner:1", api } as never);

    await backend
      .dispatchVerifier(JOB, {
        authority: {
          reserve: async (work: RuntimeWorkRef) => {
            order.push("reserve");
            return { attemptId: "a1", work, persistedAt: new Date(0).toISOString() };
          },
          activate: async () => {
            order.push("activate");
            return { kind: "activate" };
          },
        },
      })
      .catch(() => undefined);

    expect(order, "the k8s verifier created its Job without re-presenting the reservation").toEqual([
      "reserve",
      "activate",
      "apply",
    ]);
  });

  it("REFUSES to create the Job when the activation is refused", async () => {
    // The point of the transition: a cancellation that got there first turns the birth into an aborted
    // dispatch. If `applyJob` still ran, the state machine would be decoration.
    const order: string[] = [];
    const api = world(order);
    const backend = new K8sBackend({ image: "runner:1", api } as never);

    await expect(
      backend.dispatchVerifier(JOB, {
        authority: {
          reserve: async (work: RuntimeWorkRef) => {
            order.push("reserve");
            return { attemptId: "a1", work, persistedAt: new Date(0).toISOString() };
          },
          activate: async () => ({ kind: "refuse", reason: "the batch was cancelled" }),
        },
      }),
    ).rejects.toThrow(/cancelled|may no longer/i);

    expect(order, "a refused activation still produced a container").toEqual(["reserve"]);
  });
});
