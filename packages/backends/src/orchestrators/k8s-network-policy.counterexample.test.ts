import { describe, expect, it } from "vitest";
import { UNIT_LABEL, k8sNetworkPolicyFor, ownerReferencePatch } from "./k8s-network-policy.js";

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
