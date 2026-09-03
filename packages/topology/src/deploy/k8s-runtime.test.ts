import type { ServiceHarnessSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sTopologyRuntime } from "./k8s-runtime.js";
import type { Kubectl, PortForward } from "./kubectl.js";
import { worldTopologyId } from "./topology-runtime.js";

// ── WARM-TOPOLOGY IDLE RECLAMATION, ON THE K8s LANE ──────────────────────────────────────────────────
//
// The Docker and Nomad lanes have asserted their reclamation since A9; this one never had a suite at all, so
// both halves of its sweeper were claims: that it reclaims an idle topology, and — since
// world-and-engagement-model.md 3.95 — that it does NOT reclaim a created world, whose lifetime belongs to the
// created-world ledger. Three runtimes answer that one question, and a lesson learned in two of them is not
// learned in the third (rule `protocol`, the sibling-lane law).
const SPEC: ServiceHarnessSpec = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [
    { name: "agent-server", image: "reg/bu-agent:1", port: 8000, needs: [], perRun: [], replicas: 1, env: {} },
  ],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "otel", endpoint: "http://otel:4318" },
};

// The smallest kubectl that lets `deploy` finish: apply, roll out, forward a port. What the assertions read is
// what was DELETED, because a reclamation that deletes nothing and a reclamation that never ran look identical
// from the outside.
function fakeKubectl(): { kubectl: Kubectl; deletedNamespaces: string[] } {
  const deletedNamespaces: string[] = [];
  const forward: PortForward = { localPort: 41234, stop: async () => {} };
  return {
    deletedNamespaces,
    kubectl: {
      apply: async () => {},
      ensureNamespace: async () => {},
      rolloutStatus: async () => {},
      portForward: async () => forward,
      deleteResources: async () => {},
      deleteNamespace: async (ns: string) => {
        deletedNamespaces.push(ns);
      },
      exec: async () => "",
      podFor: async () => "pod-1",
    },
  };
}

function runtime(now: () => number, kubectl: Kubectl): K8sTopologyRuntime {
  return new K8sTopologyRuntime({
    kubectl,
    // The endpoint probe is an HTTP GET against the forwarded port; answering it is what makes `deploy` return.
    fetchImpl: (async () => ({ status: 200 })) as unknown as typeof fetch,
    warmIdleTtlMs: 0, // self-timer off — the sweeps below are driven explicitly, for determinism
    now,
  });
}

describe("K8sTopologyRuntime — warm-topology idle reclamation", () => {
  it("reclaims a topology idle past the TTL, and leaves an actively-used one alone", async () => {
    const { kubectl, deletedNamespaces } = fakeKubectl();
    let t = 0;
    const rt = runtime(() => t, kubectl);
    await rt.ensureTopology(SPEC);

    // Still in use: each ensure touches the idle clock, so 4 minutes after the last one is not idle.
    t = 4 * 60_000;
    await rt.ensureTopology(SPEC); // cache hit → touch
    t = 8 * 60_000;
    expect(await rt.sweepIdle(5 * 60_000)).toEqual([]);
    expect(deletedNamespaces).toEqual([]);

    // …and then nobody comes back.
    t = 20 * 60_000;
    expect(await rt.sweepIdle(5 * 60_000)).toEqual(["bu@1.0.0@default"]);
    expect(deletedNamespaces).toEqual(["everdict-default"]);
  });

  // The sibling of the Docker and Nomad assertions. A created WORLD is ensured ONCE and then used by every case
  // of a batch, so `lastUsedAt` says idle while cases are still inside it — and with the default thirty-minute
  // TTL, any batch longer than that would have its world reclaimed underneath live cases.
  it("never reclaims a created WORLD — the ledger owns that decision, not the warm pool", async () => {
    const { kubectl, deletedNamespaces } = fakeKubectl();
    let t = 0;
    const rt = runtime(() => t, kubectl);
    await rt.ensureTopology({ ...SPEC, id: worldTopologyId("run-1") });

    t = 6 * 60 * 60_000; // hours after its one and only ensure
    expect(await rt.sweepIdle(5 * 60_000)).toEqual([]);
    expect(deletedNamespaces, "a world torn out from under a live batch reads as an agent that failed").toEqual([]);
  });
});
