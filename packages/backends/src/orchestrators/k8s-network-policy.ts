import type { NetworkPolicy } from "@everdict/contracts";

// ── THE ONE AXIS A CLUSTER CAN ACTUALLY ENFORCE (arch-review 58, W5 follow-through) ──────────────────
//
// `EvalCase.network` is enforce-or-refuse, and until now every managed lane refused: neither Nomad nor K8s
// applied anything, so a case declaring a world was turned away before it was placed. That is honest and it
// is not free — an offline benchmark, which is the whole reason the axis exists, could not run on a managed
// lane at all.
//
// Exactly one shape is expressible as a Kubernetes primitive, and it happens to be the important one.
// `mode: "none"` is a deny-all egress NetworkPolicy: an empty rule list under `policyTypes: ["Egress"]`
// denies every outbound packet, DNS included, which is what "offline" means for a reasoning benchmark.
//
// `mode: "allowlist"` is NOT. NetworkPolicy peers are CIDRs and label selectors; `allowedHosts` are
// hostnames, and resolving them to addresses at dispatch time would produce a policy that is wrong the
// moment a record changes. Expressing it needs an egress proxy, which is a product decision rather than a
// manifest — so that mode keeps being refused, and the refusal now names why.
//
// The selector is the per-unit label the Job stamps on its pod template. `app: everdict` would have cut off
// every other job in the namespace, which is the difference between enforcing one case's world and taking
// the cluster down.
export const UNIT_LABEL = "everdict.dev/unit";

export function k8sNetworkPolicyFor(
  unit: string,
  network: NetworkPolicy | undefined,
): Record<string, unknown> | undefined {
  if (network?.mode !== "none") return undefined;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${unit}-egress`, labels: { app: "everdict", [UNIT_LABEL]: unit } },
    spec: {
      podSelector: { matchLabels: { [UNIT_LABEL]: unit } },
      policyTypes: ["Egress"],
      // No `egress` key at all: an empty rule list is what denies everything. A `[]` would serialize the
      // same, and stating the absence is what the API means.
    },
  };
}

// Ties the policy's lifetime to the Job's, so the cluster's garbage collector removes it whenever the Job
// goes — including the ordinary path, where `ttlSecondsAfterFinished` deletes the Job and nothing else would
// have cleaned up after it. Applied as a PATCH after the Job exists, because the reference needs its uid;
// the policy itself is created BEFORE the Job, so there is never a moment when a pod is running without it.
export function ownerReferencePatch(jobName: string, uid: string): Record<string, unknown> {
  return {
    metadata: {
      ownerReferences: [
        { apiVersion: "batch/v1", kind: "Job", name: jobName, uid, controller: false, blockOwnerDeletion: false },
      ],
    },
  };
}
