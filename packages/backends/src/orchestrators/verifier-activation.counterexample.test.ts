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
//
// ── …AND THE ORDER GOT STRONGER (arch-review 60 P0 follow-through) ─────────────────────────────────
//
// Activating immediately BEFORE the apply narrowed the window to one call and did not remove it: a submitter
// paused across that call holds an activation it never re-reads. The Job is created INERT now (`suspend:
// true` — it exists, it is addressable, it creates no pods), the reservation is re-presented against an
// object a teardown can already find, and only then is it made runnable. So the sequence this file pins is
//
//     reserve · apply(inert) · activate · resume
//
// and a REFUSED activation deletes what this dispatch made rather than leaving it.

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
      order.push("apply(inert)");
    },
    async resumeJob() {
      order.push("resume");
      // Stops here on purpose: what this file is about is the ORDER up to the moment the object may RUN, and
      // letting the poll proceed would only add a fake cluster's lifecycle to a test that does not ask.
      throw new Error("stop after it becomes runnable");
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
      order.push("delete");
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

const RESERVE = async (work: RuntimeWorkRef) => ({
  attemptId: "a1",
  work,
  persistedAt: new Date(0).toISOString(),
});

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

    // The PREFIX, not the total: everything this dispatch created is reclaimed in one `finally` now
    // (arch-review 61 P1-high), so a delete follows on every path including this one. What this file pins is
    // that the object exists before the authority is asked, and runs only after it answers.
    expect(order.slice(0, 4), "the k8s verifier made its Job runnable without re-presenting the reservation").toEqual([
      "reserve",
      "apply(inert)",
      "activate",
      "resume",
    ]);
  });

  it("removes the object when the RESUME fails — suspended is not finished, so nothing else collects it", () => {
    // arch-review 61 P1-high. The reclaim used to open below `resumeJob`, so a resume that threw left a
    // suspended Job forever: suspended is not a terminal state, so `ttlSecondsAfterFinished` never collects
    // it either. And a resume the API server APPLIED whose response was lost left a RUNNING Job the caller
    // believed had failed, so a retry placed a second one — live duplicate compute writing competing
    // evidence for one case.
    const order: string[] = [];
    const api = {
      ...world(order),
      resumeJob: async () => {
        order.push("resume");
        throw new Error("the API server did not answer");
      },
    };
    const backend = new K8sBackend({ image: "runner:1", api } as never);

    return backend
      .dispatchVerifier(JOB, { authority: { reserve: RESERVE, activate: async () => ({ kind: "activate" as const }) } })
      .then(
        () => expect.unreachable("a resume that failed should not produce a verdict"),
        () => {
          expect(order, "a suspended Job was left behind when its resume failed").toContain("delete");
          expect(order.indexOf("delete")).toBeGreaterThan(order.indexOf("resume"));
        },
      );
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

    // The inert object was created — that is the point, a teardown could always find it — and then REMOVED
    // by its own creator, so nothing that could run ever existed and the cancellation's certificate holds.
    expect(order, "a refused activation left an object behind, or made one runnable").toEqual([
      "reserve",
      "apply(inert)",
      "delete",
    ]);
    // …and the delete came from the ONE reclaim rather than a hand-rolled catch, which is what makes it fire
    // for a resume that threw as well as for a refusal.
    expect(
      order.filter((o) => o === "delete"),
      "the object was removed more than once",
    ).toHaveLength(1);
  });
});
