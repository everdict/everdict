import { buildK8sJob } from "@everdict/backends";
import type { CaseJob, ServiceHarnessSpec } from "@everdict/contracts";
import { UNTRUSTED_POD_IDENTITY } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildK8sManifests } from "./deploy/k8s-topology.js";

// ── AN UNTRUSTED POD CARRIES NO IDENTITY IN OUR CLUSTER (arch-review 59 follow-through) ──────────────
//
// Kubernetes mounts the namespace's default ServiceAccount token into every pod unless the spec says
// otherwise, and nothing in this repo said otherwise — `automountServiceAccountToken` appeared nowhere. So
// every eval pod, every topology service and every provisioned dependency came up with a bearer token for
// our cluster API at a well-known path, in a container running the tenant's own image with the agent under
// test inside it:
//
//     cat /var/run/secrets/kubernetes.io/serviceaccount/token
//
// What that reaches depends on what the default SA is bound to in whichever cluster an operator pointed a
// RuntimeSpec at. That is not knowable from here, which is exactly why it may not be assumed to be nothing.
// The hardened runtime `assertHardenedIsolation` already insists on is about the KERNEL boundary; a
// credential handed in at the front door goes around it.
//
// Asserted over EVERY builder in one file, on purpose. This is a one-field invariant that must hold in three
// places, and an invariant written three times grows its next exception in two of them — the shape rule
// `backends` names outright and the reason `UNTRUSTED_POD_IDENTITY` has one owner in `@everdict/domain`.
//
// Seen RED before the field existed, observed:
//   the agent under test's pod mounts a token for our cluster API: expected undefined to be false

const podSpecsOf = (m: unknown): Array<Record<string, unknown>> => {
  const manifests = Array.isArray(m) ? m : [m];
  return manifests.flatMap((x) => {
    const o = x as { spec?: { template?: { spec?: Record<string, unknown> } } };
    return o.spec?.template?.spec ? [o.spec.template.spec] : [];
  });
};

const CASE_JOB = {
  tenant: "acme",
  runId: "evd-run-r1",
  harness: { id: "h", version: "1" },
  evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, tags: [] },
} as unknown as CaseJob;

// The shape the other topology tests use — a hand-built one is missing fields the render actually reads
// (`services[].env`), which is an exception rather than a measurement (rule `testing`).
const TOPOLOGY: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "reg/echo:1", port: 8080, needs: [], perRun: [], replicas: 1, env: {} }],
  dependencies: [{ store: "postgres", role: "state", purpose: "data", isolateBy: "schema" }],
  target: { kind: "browser", engine: "chromium", lifecycle: "per-case-instance", observe: ["url"] },
  frontDoor: { service: "agent-server", submit: "POST /runs" },
} as unknown as ServiceHarnessSpec;

describe("[R59 COUNTEREXAMPLE] no pod this repo emits for tenant code holds a cluster credential", () => {
  it("the eval Job's pod mounts no ServiceAccount token", () => {
    const specs = podSpecsOf(buildK8sJob(CASE_JOB, { image: "runner:1" }, "evd-c1", "ns"));
    expect(specs, "the builder produced no pod spec, so this test measured nothing").toHaveLength(1);
    expect(
      specs[0]?.automountServiceAccountToken,
      "the agent under test's pod mounts a token for our cluster API",
    ).toBe(false);
  });

  it("every topology pod — services AND provisioned dependencies — says the same", () => {
    // The dependency stores are ours, but they run beside a harness's own code and are reachable from it;
    // a store pod with a cluster token is the same credential one hop away.
    const specs = podSpecsOf(buildK8sManifests(TOPOLOGY, { provisionDependencies: true }));
    // Cardinality, not presence: `provisionDependencies` must actually have rendered the store pod beside the
    // service, or this loop is iterating one manifest and calling it "every topology pod".
    expect(specs.length, "the dependency store pod was never rendered, so this test covered only the service").toBe(2);
    for (const spec of specs)
      expect(spec.automountServiceAccountToken, "a topology pod mounts a token for our cluster API").toBe(false);
  });

  it("is UNCONDITIONAL — the same field whatever the placement decided", () => {
    // A trusted tenant is one we let share a kernel. It is not one that needs to call our control plane from
    // inside an eval, and no lane has ever used the token for anything, so this is a capability removed
    // rather than a policy with a knob somebody eventually sets wrong for an unrelated reason.
    //
    // Said as a property of the BUILDER rather than of a zone object: the zone is resolved before this
    // function is reached, and every shape it can produce lands here as options. A hardened placement and a
    // bare one must be identical on this field.
    for (const opts of [
      { image: "runner:1" },
      { image: "runner:1", hostNetwork: true },
      { image: "runner:1", imagePullPolicy: "Always" as const },
    ]) {
      const hardened = podSpecsOf(buildK8sJob(CASE_JOB, opts, "n", "ns", "runsc"));
      const bare = podSpecsOf(buildK8sJob(CASE_JOB, opts, "n", "ns"));
      expect(hardened[0]?.automountServiceAccountToken).toBe(false);
      expect(bare[0]?.automountServiceAccountToken).toBe(false);
    }
    // …and the constant itself carries no other field, so spreading it cannot quietly change a pod's shape.
    expect(UNTRUSTED_POD_IDENTITY).toEqual({ automountServiceAccountToken: false });
  });
});
