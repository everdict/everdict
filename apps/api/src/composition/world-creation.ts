import type { WorldCreator } from "@everdict/application-control";
import { BadRequestError, k8sTopologyTransport, nomadTopologyTransport } from "@everdict/contracts";
import {
  DockerTopologyRuntime,
  K8sTopologyRuntime,
  NomadTopologyRuntime,
  type TopologyRuntime,
  topologyWorldCreator,
} from "@everdict/topology";
import type { ResolvedRuntime } from "../common/runtime-compute.js";

// ── THE PRODUCTION CREATOR OF WORLDS (docs/architecture/world-and-engagement-model.md, 3.9) ──────────
//
// A created world stands on the TENANT'S OWN runtime, resolved exactly the way an interactive browser
// session and a file run resolve theirs — one answer to "which cluster, which credential, which zone"
// instead of one per lane. The protocol around it (record before creating, settle only on a read-back) lives
// in `@everdict/application-control`; this is the part that knows how to reach a cluster.
//
// NOMAD FIRST, and refused by name elsewhere. The browser-session lane made the same call for the same
// reason: K8s needs a port-forward story and the self-hosted lane a reverse relay, and a world that came up
// on a runtime this control plane cannot then tear down is precisely the leak the ledger exists to prevent.
// A refusal here is a case that does not run; a silent fallback would be a world nobody reclaims.
export function buildWorldCreator(deps: {
  resolve: (tenant: string, runtimeId: string) => Promise<ResolvedRuntime | undefined>;
}): WorldCreator {
  const creatorFor = async (tenant: string, target: string | undefined): Promise<WorldCreator> => {
    if (target === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant },
        "this case creates its world and names no runtime to create it on — a world with no cluster has nowhere to stand and nothing to tear it down",
      );
    const resolved = await deps.resolve(tenant, target);
    if (resolved === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant, runtime: target },
        `no such runtime '${target}' in this workspace — the world was not created`,
      );
    // WHAT A CREATOR ACTUALLY NEEDS is narrower than what a browser session needs, and copying that lane's
    // Nomad-only constraint was the wrong inheritance: a session needs `provisionBrowserEnv` plus a CDP this
    // control plane can reach, while a WORLD needs only ensure/teardown/describe — which Nomad, K8s and the
    // local Docker runtime all implement. What is genuinely required is that the runtime can PROVE a teardown
    // (`describeTopology`), because a world we cannot say is gone is the leak the ledger exists to prevent.
    const runtime: TopologyRuntime =
      resolved.spec.kind === "nomad"
        ? new NomadTopologyRuntime({
            addr: resolved.spec.addr,
            ...(resolved.apiToken ? { apiToken: resolved.apiToken } : {}),
            ...nomadTopologyTransport(resolved.spec),
          })
        : resolved.spec.kind === "k8s"
          ? new K8sTopologyRuntime({
              ...(resolved.spec.context ? { context: resolved.spec.context } : {}),
              ...k8sTopologyTransport(resolved.spec),
            })
          : // `local` — the deployment's own Docker daemon, which is what a self-hosted runner and a dev
            // control plane both stand on.
            new DockerTopologyRuntime();
    if (runtime.describeTopology === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: target, kind: resolved.spec.kind },
        `the '${resolved.spec.kind}' runtime cannot say whether a topology is still standing, so a world created on it could never be proved gone — the case is refused rather than run into a leak`,
      );
    return topologyWorldCreator(runtime);
  };
  return {
    create: async (input) => (await creatorFor(input.tenant, input.target)).create(input),
    destroy: async (input) => (await creatorFor(input.tenant, input.target)).destroy(input),
    standing: async (input) => {
      // The read-back may not throw its way into a settlement: a runtime this process cannot even resolve is
      // "we could not find out", which keeps the row owed rather than releasing it on an error's say-so.
      try {
        return await (await creatorFor(input.tenant, input.target)).standing(input);
      } catch {
        return undefined;
      }
    },
  };
}
