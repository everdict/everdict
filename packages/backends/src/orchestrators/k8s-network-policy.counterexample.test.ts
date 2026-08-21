import { worldProofCovers } from "@everdict/contracts";
import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { UNIT_LABEL, k8sNetworkPolicyFor, ownerReferencePatch } from "./k8s-network-policy.js";
import { buildK8sJob } from "./k8s.js";

// ── ONE NETWORK MODE A CLUSTER CAN ACTUALLY ENFORCE (arch-review 58, W5 follow-through) ──────────────
//
// The lanes refuse a network declaration because they enforce none, which is honest and costs the axis its
// reason for existing: an offline reasoning benchmark — the case `mode: "none"` was added for — could not
// run on a managed lane at all.
//
// Exactly one shape is a Kubernetes primitive. Deny-all egress is a NetworkPolicy with `policyTypes:
// ["Egress"]` and no rules; `allowlist` over HOSTNAMES is not, because policy peers are CIDRs and selectors
// and resolving names at dispatch produces a policy that is wrong the moment a record moves. So this closes
// the mode that can be closed and leaves the other refused, which is the same enforce-or-refuse contract one
// step further along.
//
// WHAT THIS FILE CANNOT PROVE is that a cluster honours the manifest — that needs a cluster, and it lives in
// the env-gated live scenario beside it. What it does prove is the part that is ours: the selector, the
// direction, and the lifetime. Each of those has a failure mode worse than not shipping:
//
//   · a selector of `app: everdict` cuts off every other job in the namespace;
//   · an INGRESS policy silently enforces nothing an eval cares about;
//   · a policy with no owner outlives its Job, and `ttlSecondsAfterFinished` deletes the Job without it.
//
// Seen RED before the builder existed:
//   Cannot find module './k8s-network-policy.js'

const spec = (p: Record<string, unknown> | undefined) => (p?.spec ?? {}) as Record<string, unknown>;

describe("[R58 W5 COUNTEREXAMPLE] deny-all egress is expressed as a policy the cluster can apply", () => {
  it("denies EGRESS for exactly this unit's pods", () => {
    const policy = k8sNetworkPolicyFor("evd-c1-aaaa", { mode: "none", allowedHosts: [] });
    expect(policy, "an offline case produced no policy at all").toBeDefined();
    expect(
      spec(policy).policyTypes,
      "the policy governs the wrong direction — ingress is not what an eval declares",
    ).toEqual(["Egress"]);
    // No rules IS the denial. A rule list would be a permission.
    expect(spec(policy).egress).toBeUndefined();
    expect(spec(policy).podSelector).toEqual({ matchLabels: { [UNIT_LABEL]: "evd-c1-aaaa" } });
  });

  it("selects THIS unit, never the whole app", () => {
    // The difference between enforcing one case's world and taking the namespace down.
    const selector = spec(k8sNetworkPolicyFor("evd-c1-aaaa", { mode: "none", allowedHosts: [] })).podSelector;
    expect(JSON.stringify(selector)).not.toContain('everdict"');
    expect(JSON.stringify(selector)).toContain("evd-c1-aaaa");
  });

  it("produces NOTHING for a mode a manifest cannot express", () => {
    // `allowlist` over hostnames needs an egress proxy, not a policy. Emitting a policy that silently did
    // less than the declaration asked would be worse than refusing: the case would run in a world nobody
    // provided, under a lane that believed it had.
    expect(k8sNetworkPolicyFor("u", { mode: "allowlist", allowedHosts: ["api.example.com"] })).toBeUndefined();
    expect(k8sNetworkPolicyFor("u", { mode: "public", allowedHosts: [] })).toBeUndefined();
    expect(k8sNetworkPolicyFor("u", undefined)).toBeUndefined();
  });

  it("ties the policy's life to the Job's, so the ordinary exit cleans it up", () => {
    // `ttlSecondsAfterFinished` deletes the Job and knows nothing about a policy beside it. An owner
    // reference makes the cluster's garbage collector do it, on every path — including the one where nothing
    // of ours runs again.
    const patch = ownerReferencePatch("evd-c1-aaaa", "uid-123") as {
      metadata: { ownerReferences: Array<Record<string, unknown>> };
    };
    const ref = patch.metadata.ownerReferences[0];
    expect(ref).toMatchObject({ kind: "Job", name: "evd-c1-aaaa", uid: "uid-123" });
    // NOT the controller, and it must not block the Job's own deletion: the policy is a dependent, and a
    // dependent that can stall its owner's removal turns a cleanup into a stuck namespace.
    expect(ref?.controller).toBe(false);
    expect(ref?.blockOwnerDeletion).toBe(false);
  });
});

// ── AND THE CONTAINER HAS TO ACCEPT THE WORLD THE LANE BUILT ────────────────────────────────────────
//
// The policy object was the easy half. `withWorldProof` still claimed only `resources`, and its own comment
// still said no lane writes a network object — so the opt-in offline path applied the NetworkPolicy, started
// the Job, and the in-container `worldProofCovers` then refused the case for lack of a network proof. The
// feature was inert end to end, and every unit test above passed while it was (arch-review 59 P1-high).
//
// Seen RED before the proof learned the axis, observed:
//   the container refused a world this lane actually built: expected false to be true
describe("[R59 COUNTEREXAMPLE] an offline world the lane enforced is a world the container accepts", () => {
  const offlineJob = (): CaseJob =>
    ({
      tenant: "acme",
      runId: "evd-run-r1",
      harness: { id: "h", version: "1" },
      evalCase: {
        id: "c1",
        task: "t",
        env: { kind: "prompt" },
        graders: [],
        timeoutSec: 60,
        network: { mode: "none", allowedHosts: [] },
      },
    }) as unknown as CaseJob;

  const proofFrom = (spec: unknown): CaseJob["worldProof"] => {
    // From the INIT container, not the agent's: the payload stopped travelling in the agent's environment
    // (arch-review 59 follow-through), and the step that still holds it has terminated before the agent runs.
    const init = (
      spec as {
        spec: { template: { spec: { initContainers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } };
      }
    ).spec.template.spec.initContainers;
    const payload = init?.[0]?.env?.[0]?.value;
    if (payload === undefined) throw new Error("no case payload on the pod");
    return (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as CaseJob).worldProof;
  };

  it("attests the network axis when it applied the policy, so the driver runs", () => {
    const spec = buildK8sJob(offlineJob(), { image: "runner:1", enforcesNetwork: true }, "evd-c1", "ns");
    const proof = proofFrom(spec);
    expect(
      worldProofCovers(proof, undefined, { mode: "none", allowedHosts: [] }),
      "the container refused a world this lane actually built",
    ).toBe(true);
  });

  it("REFUSES rather than attesting, when the operator has not said this cluster enforces it", () => {
    // The two halves are one decision. Without the opt-in the lane does not build a policy, so it has nothing
    // to attest — and rather than placing the case with a silent gap it turns it away, because a manifest
    // applied to a cluster with no policy controller is accepted and inert.
    expect(() => buildK8sJob(offlineJob(), { image: "runner:1" }, "evd-c1", "ns")).toThrow(/cannot enforce/i);
  });

  it("does not claim the axis for a mode it cannot render", () => {
    const allowlist = offlineJob();
    (allowlist.evalCase as { network: unknown }).network = { mode: "allowlist", allowedHosts: ["api.example.com"] };
    // The lane refuses this case outright; the point here is that if it ever stopped refusing, the proof
    // would still not claim what no manifest expresses.
    expect(k8sNetworkPolicyFor("u", { mode: "allowlist", allowedHosts: ["api.example.com"] })).toBeUndefined();
  });

  it("REFUSES hostNetwork + enforcesNetwork — a policy that cannot apply must not be attested", () => {
    // Kubernetes leaves NetworkPolicy behaviour undefined for a hostNetwork pod and the common
    // implementations do not match one against a selector. That combination is a lane that applies a policy,
    // claims the axis, and constrains nothing: the false attestation this whole change removes, arriving by
    // configuration rather than by code.
    expect(() =>
      buildK8sJob(offlineJob(), { image: "runner:1", enforcesNetwork: true, hostNetwork: true }, "evd-c1", "ns"),
    ).toThrow(/hostNetwork/);
  });
});
