import type { RuntimeWorkRef, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend } from "./k8s.js";
import { verifierCaseJob } from "./verifier-placement.js";

// ── THE JUDGING HALF IS HELD TO THE WORLD THE CASE DECLARED (arch-review 59 P1-high) ─────────────────
//
// `resources` travels from the case to the verifier job so a verdict is not reached in a bigger box than the
// run happened in. `network` did not travel, and nothing in the type said it should: a case declaring
// `none` (offline) had its agent placed behind a deny-all egress NetworkPolicy and its VERIFIER placed with egress
// wide open, on the same cluster, minutes apart.
//
// The mild reading is the `resources` argument again — a verdict reached online about a run that happened
// offline answers a different question. The sharp one is what the verifier container IS: the place the hidden
// tests execute and the reward is computed, deliberately somewhere the agent has never been (arch-review 56
// Wave I). A `none` declaration constrains the grading procedure too, and leaving egress open there opens
// the network in the one container the whole design exists to keep separate.
//
// Both halves are one change, because either alone is inert: the field has to reach the lane, and the lane
// has to apply what it now knows. That is the shape the previous review found here twice — a proof that
// learned an axis nobody enforced, and an axis enforced by a lane whose proof refused to claim it.
//
// Seen RED under both neutralizations, for the stated reasons. With the lane applying no policy:
//   the verifier ran with egress open while the agent was placed offline: expected [ 'apply(job)' ] to
//   deeply equal [ 'apply(networkpolicy)', 'apply(job)' ]
// …and with the field not reaching the placement, which is the half that decides enforce-or-refuse:
//   the lane decides the verifier's world from a case that never mentioned the network: expected undefined
//   to deeply equal { mode: 'none', allowedHosts: [] }

const JOB = (mode?: "none"): VerifierJob =>
  ({
    runId: "evd-sc-1-c1-t0",
    tenant: "acme",
    caseId: "c1",
    workdir: "/app",
    workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
    plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
    timeoutSec: 60,
    ...(mode ? { network: { mode, allowedHosts: [] } } : {}),
  }) as unknown as VerifierJob;

// A cluster that records what it was asked to create, in order.
function world(order: string[]) {
  return {
    async ensureNamespace() {},
    async patchNetworkPolicy() {},
    async applyJob(m: { kind?: string }) {
      if (m.kind === "NetworkPolicy") {
        order.push("apply(networkpolicy)");
        return;
      }
      order.push("apply(job)");
      // Stops at the Job on purpose: what this file asks about is what exists in the cluster before the
      // verifier's container can run, and letting the poll proceed would only add a fake's lifecycle to it.
      throw new Error("stop after the birth");
    },
    async jobStatus() {
      return { status: "succeeded" as const };
    },
    async podLogs() {
      return "";
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

const AUTHORITY = {
  reserve: async (work: RuntimeWorkRef) => ({ attemptId: "a1", work, persistedAt: new Date(0).toISOString() }),
  activate: async () => ({ kind: "activate" as const }),
};

describe("[R59 COUNTEREXAMPLE] a verifier is placed in the network world its case declared", () => {
  it("carries the declared network onto the placement the lane decides from", () => {
    // The field has to reach the synthetic case job, or the lane's own enforce-or-refuse decision is made
    // against a world nobody declared — which reads as "no constraint" rather than as a missing value.
    expect(
      verifierCaseJob(JOB("none")).evalCase.network,
      "the lane decides the verifier's world from a case that never mentioned the network",
    ).toEqual({ mode: "none", allowedHosts: [] });
  });

  it("applies the egress denial BEFORE the verifier Job exists", async () => {
    const order: string[] = [];
    const backend = new K8sBackend({
      image: "runner:1",
      api: world(order),
      enforcesNetwork: true,
    } as never);

    await backend.dispatchVerifier(JOB("none"), { authority: AUTHORITY }).catch(() => undefined);

    expect(order, "the verifier ran with egress open while the agent was placed offline").toEqual([
      "apply(networkpolicy)",
      "apply(job)",
    ]);
  });

  it("REFUSES rather than grading in a world it cannot constrain", async () => {
    // The other direction, and the one that must not be traded away for the first: a lane whose operator has
    // NOT said it enforces NetworkPolicy silently grades online. `buildK8sJob`'s enforce-or-refuse already
    // owns this decision — carrying the field is what finally lets it see the verifier at all.
    const order: string[] = [];
    const backend = new K8sBackend({ image: "runner:1", api: world(order) } as never);

    await expect(backend.dispatchVerifier(JOB("none"), { authority: AUTHORITY })).rejects.toThrow(/network|enforce/i);
    expect(order, "a world this lane cannot constrain still produced a verifier container").toEqual([]);
  });

  it("places an ordinary verifier with no policy at all", async () => {
    // A case that declared nothing gets nothing invented for it. A lane defaulting verifiers to deny-all
    // would be the same defect pointed the other way — a world the case did not declare.
    const order: string[] = [];
    const backend = new K8sBackend({ image: "runner:1", api: world(order), enforcesNetwork: true } as never);

    await backend.dispatchVerifier(JOB(), { authority: AUTHORITY }).catch(() => undefined);
    expect(order).toEqual(["apply(job)"]);
  });
});
